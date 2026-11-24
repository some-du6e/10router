// Package proxy relays requests to the Node app server without buffering
// either body: request bodies stream to Node as they arrive, and every chunk
// Node writes (one SSE event, typically) is flushed to the client at once.
package proxy

import (
	"bufio"
	"context"
	"errors"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"net/netip"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// The peer headers: the client connection the gateway accepted, for the app
// server to use in place of its own TCP peer (which is always the gateway),
// proven by a token only the two processes know. custom-server.js reads and
// removes them; any copy a client sent is replaced here.
const (
	HeaderPeerToken = "X-9r-Gw-Token"
	HeaderPeerIP    = "X-9r-Gw-Peer-Ip"
	HeaderPeerPort  = "X-9r-Gw-Peer-Port"
)

// custom-server.js's FORWARDING_HEADERS. The app server applies its own rule
// to them (a loopback or TRUST_PROXY-listed peer's are read, anyone else's
// ignored), so they reach it exactly as the client sent them. ReverseProxy
// drops the X-Forwarded ones before Rewrite runs, and any of them a client
// names in Connection; Node honoured neither.
var forwardingHeaders = []string{
	"Forwarded", "X-Forwarded-For", "X-Forwarded-Host", "X-Forwarded-Proto", "X-Real-Ip", "True-Client-Ip",
	"Cf-Connecting-Ip", "Cf-Ray", "Tailscale-Funnel-Request",
}

// Options configure a Proxy.
type Options struct {
	// Upstream is the app server, e.g. http://127.0.0.1:20129.
	Upstream *url.URL
	// PeerToken, when set, is sent with the peer headers.
	PeerToken string
	// RequestTimeout bounds how long a client may take to send its body, as
	// Node's server.requestTimeout does (0: no bound).
	RequestTimeout time.Duration
	// ListenIPv6 is true when the public listener is an IPv6 socket, where
	// Node would see an IPv4 client as ::ffff:a.b.c.d.
	ListenIPv6 bool
	// Transport overrides the default transport (tests).
	Transport http.RoundTripper
	Logger    *log.Logger
}

// Proxy is an http.Handler that relays to the app server.
type Proxy struct {
	rp             *httputil.ReverseProxy
	peerToken      string
	requestTimeout time.Duration
	listenIPv6     bool
	logger         *log.Logger
}

type ctxKey int

const (
	keyH2C ctxKey = iota
	keyBodyState
)

// NewTransport is the transport to the app server: a loopback hop, so no
// HTTP proxy from the environment, no transparent gzip (the client's own
// Accept-Encoding goes through untouched), no response-header timeout (Node
// sends early SSE headers itself and owns the upstream's 240 s limit), and a
// pool big enough that concurrent streams don't open a connection each time.
func NewTransport(idleConnTimeout time.Duration) *http.Transport {
	return &http.Transport{
		Proxy:                 nil,
		DialContext:           (&net.Dialer{Timeout: 5 * time.Second, KeepAlive: 30 * time.Second}).DialContext,
		ForceAttemptHTTP2:     false,
		DisableCompression:    true,
		MaxIdleConns:          0,
		MaxIdleConnsPerHost:   512,
		IdleConnTimeout:       idleConnTimeout,
		ResponseHeaderTimeout: 0,
		ExpectContinueTimeout: 0,
		WriteBufferSize:       64 << 10,
		ReadBufferSize:        64 << 10,
	}
}

// New returns a Proxy.
func New(o Options) *Proxy {
	logger := o.Logger
	if logger == nil {
		logger = log.Default()
	}
	p := &Proxy{peerToken: o.PeerToken, requestTimeout: o.RequestTimeout, listenIPv6: o.ListenIPv6, logger: logger}
	transport := o.Transport
	if transport == nil {
		transport = NewTransport(20 * time.Second)
	}
	upstream := o.Upstream
	p.rp = &httputil.ReverseProxy{
		Rewrite: func(pr *httputil.ProxyRequest) {
			pr.SetURL(upstream)
			// The client's query as sent: ReverseProxy re-encodes one with a
			// ';' or a bad '%' escape, dropping those parameters.
			pr.Out.URL.RawQuery = pr.In.URL.RawQuery
			// The client's Host, not the upstream's: the app's origin checks,
			// tunnel detection and local-client rule all read it.
			pr.Out.Host = pr.In.Host
			for _, name := range forwardingHeaders {
				if v, ok := pr.In.Header[name]; ok {
					pr.Out.Header[name] = v
				}
			}
			// The gateway already answered the client's Expect: 100-continue.
			pr.Out.Header.Del("Expect")
			p.setPeer(pr.Out, pr.In)
		},
		Transport:     transport,
		FlushInterval: -1,
		BufferPool:    bufferPool{},
		ErrorLog:      log.New(io.Discard, "", 0),
		ErrorHandler:  p.errorHandler,
		ModifyResponse: func(res *http.Response) error {
			// Node closes an h2c-downgraded connection after the reply; so do we.
			if h2c, _ := res.Request.Context().Value(keyH2C).(bool); h2c {
				res.Header.Set("Connection", "close")
			}
			return nil
		},
	}
	return p
}

// setPeer replaces any peer header the client sent with the gateway's own.
func (p *Proxy) setPeer(out, in *http.Request) {
	out.Header.Del(HeaderPeerToken)
	out.Header.Del(HeaderPeerIP)
	out.Header.Del(HeaderPeerPort)
	if p.peerToken == "" {
		return
	}
	ip, port := PeerOf(in.RemoteAddr, p.listenIPv6)
	out.Header.Set(HeaderPeerToken, p.peerToken)
	out.Header.Set(HeaderPeerIP, ip)
	out.Header.Set(HeaderPeerPort, port)
}

// PeerOf splits a RemoteAddr into the address and port Node's socket would
// report for the same connection: an IPv4 client of an IPv6 listener is
// ::ffff:a.b.c.d there, and plain a.b.c.d on an IPv4 one.
func PeerOf(remoteAddr string, listenIPv6 bool) (ip, port string) {
	ap, err := netip.ParseAddrPort(remoteAddr)
	if err != nil {
		host, p, splitErr := net.SplitHostPort(remoteAddr)
		if splitErr != nil {
			return remoteAddr, ""
		}
		return host, p
	}
	addr := ap.Addr()
	switch {
	case listenIPv6 && (addr.Is4() || addr.Is4In6()):
		ip = "::ffff:" + addr.Unmap().String()
	case addr.Is4In6():
		ip = addr.Unmap().String()
	default:
		ip = addr.String()
	}
	return ip, strconv.Itoa(int(ap.Port()))
}

// ServeHTTP relays one request.
func (p *Proxy) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if isH2CUpgrade(r.Header) {
		// What custom-server.js does with an h2c upgrade (JBR sends them):
		// serve it as the HTTP/1.1 request it also is.
		stripH2C(r.Header)
		r = r.WithContext(context.WithValue(r.Context(), keyH2C, true))
	}
	if r.Header.Get("Upgrade") != "" {
		w = upgradeWriter{w}
	}
	if p.requestTimeout > 0 && hasBody(r) {
		timedOut := &atomic.Bool{}
		rc := http.NewResponseController(w)
		if err := rc.SetReadDeadline(time.Now().Add(p.requestTimeout)); err == nil {
			r.Body = &deadlineBody{ReadCloser: r.Body, rc: rc, timedOut: timedOut}
			r = r.WithContext(context.WithValue(r.Context(), keyBodyState, timedOut))
		}
	}
	p.rp.ServeHTTP(w, r)
}

func hasBody(r *http.Request) bool {
	return r.Body != nil && r.Body != http.NoBody && (r.ContentLength != 0 || len(r.TransferEncoding) > 0)
}

func isH2CUpgrade(h http.Header) bool {
	for _, v := range h.Values("Upgrade") {
		for _, token := range strings.Split(v, ",") {
			if strings.EqualFold(strings.TrimSpace(token), "h2c") {
				return true
			}
		}
	}
	return false
}

func stripH2C(h http.Header) {
	h.Del("Upgrade")
	h.Del("Http2-Settings")
	var keep []string
	for _, v := range h.Values("Connection") {
		for _, token := range strings.Split(v, ",") {
			t := strings.TrimSpace(token)
			if t == "" || strings.EqualFold(t, "upgrade") || strings.EqualFold(t, "http2-settings") {
				continue
			}
			keep = append(keep, t)
		}
	}
	h.Del("Connection")
	if len(keep) > 0 {
		h.Set("Connection", strings.Join(keep, ", "))
	}
}

// upgradeWriter makes the hijacked connection ReverseProxy splices to the app
// server read through the server's buffer first. ReverseProxy copies from the
// raw connection, so bytes the client sent right behind its upgrade request
// (Codex sends its response.create frame without waiting for the 101) would
// be left in that buffer and lost.
type upgradeWriter struct{ http.ResponseWriter }

func (u upgradeWriter) Unwrap() http.ResponseWriter { return u.ResponseWriter }

func (u upgradeWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	conn, brw, err := http.NewResponseController(u.ResponseWriter).Hijack()
	if err != nil {
		return nil, nil, err
	}
	return bufferedConn{Conn: conn, r: brw.Reader}, brw, nil
}

type bufferedConn struct {
	net.Conn
	r *bufio.Reader
}

func (c bufferedConn) Read(p []byte) (int, error) { return c.r.Read(p) }

// deadlineBody lifts the read deadline once the body has been read, so the
// response (an SSE stream of ten minutes or more) is never cut by it.
type deadlineBody struct {
	io.ReadCloser
	rc       *http.ResponseController
	timedOut *atomic.Bool
	once     sync.Once
}

func (b *deadlineBody) Read(buf []byte) (int, error) {
	n, err := b.ReadCloser.Read(buf)
	if err == io.EOF {
		b.once.Do(func() { _ = b.rc.SetReadDeadline(time.Time{}) })
	} else if err != nil {
		var ne net.Error
		if errors.As(err, &ne) && ne.Timeout() {
			b.timedOut.Store(true)
		}
	}
	return n, err
}

var upstreamErrorBody = []byte(`{"error":{"message":"The gateway could not reach the app server; retry shortly.","type":"server_error","code":"gateway_upstream_unavailable"}}`)

func (p *Proxy) errorHandler(w http.ResponseWriter, r *http.Request, err error) {
	if timedOut, _ := r.Context().Value(keyBodyState).(*atomic.Bool); timedOut != nil && timedOut.Load() {
		// Node answers a body that misses requestTimeout with a bare 408.
		w.Header().Set("Connection", "close")
		w.WriteHeader(http.StatusRequestTimeout)
		return
	}
	if r.Context().Err() != nil {
		// The client left; the upstream request was cancelled with it.
		return
	}
	p.logger.Printf("[Gateway] proxy error: %s %s: %v", r.Method, r.URL.Path, err)
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Content-Length", strconv.Itoa(len(upstreamErrorBody)))
	w.Header().Set("Retry-After", "1")
	w.WriteHeader(http.StatusBadGateway)
	_, _ = w.Write(upstreamErrorBody)
}

var buffers = sync.Pool{New: func() any { b := make([]byte, 32<<10); return &b }}

type bufferPool struct{}

func (bufferPool) Get() []byte  { return *(buffers.Get().(*[]byte)) }
func (bufferPool) Put(b []byte) { buffers.Put(&b) }
