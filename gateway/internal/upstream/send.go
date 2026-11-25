package upstream

import (
	"bufio"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/some-du6e/10router/gateway/internal/claudeprep"
)

// wireDefaults are the headers Node's fetch (undici) adds when the request
// has none of that name, in its order. accept-encoding depends on the scheme
// (encodingFor); the recorder holds both to Node's fetch.
var wireDefaults = [][2]string{
	{"accept", "*/*"},
	{"accept-language", "*"},
	{"sec-fetch-mode", "cors"},
	{"user-agent", "node"},
	{"accept-encoding", ""},
}

// encodingFor is the accept-encoding undici asks for: brotli too over https.
// The gateway decodes only gzip; a brotli reply goes to Node.
func encodingFor(target string) string {
	if strings.HasPrefix(strings.ToLower(target), "https:") {
		return "br, gzip, deflate"
	}
	return "gzip, deflate"
}

// Sender sends one request the way proxyAwareFetch sends it directly.
type Sender struct {
	Client *http.Client
}

// NewSender is a sender with undici's connection behavior: HTTP/1.1 only, a
// 10 s connect timeout, idle connections kept 4 s, and Node's 16 KB limit on
// response headers. Redirects aren't followed: the caller hands them to Node.
func NewSender() *Sender {
	dialer := &net.Dialer{Timeout: connectTimeout, KeepAlive: 30 * time.Second}
	transport := &http.Transport{
		Proxy:       nil,
		DialContext: dialer.DialContext,
		// undici's connect timeout covers the TCP connect and the TLS
		// handshake together.
		DialTLSContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
			ctx, cancel := context.WithTimeout(ctx, connectTimeout)
			defer cancel()
			raw, err := dialer.DialContext(ctx, network, addr)
			if err != nil {
				return nil, err
			}
			host, _, err := net.SplitHostPort(addr)
			if err != nil {
				host = addr
			}
			c := tls.Client(raw, &tls.Config{ServerName: host, NextProtos: []string{"http/1.1"}})
			if err := c.HandshakeContext(ctx); err != nil {
				raw.Close()
				return nil, err
			}
			return c, nil
		},
		ForceAttemptHTTP2:      false,
		TLSNextProto:           map[string]func(string, *tls.Conn) http.RoundTripper{},
		IdleConnTimeout:        4 * time.Second,
		MaxIdleConnsPerHost:    64,
		MaxResponseHeaderBytes: 16 << 10,
		DisableCompression:     true,
	}
	return &Sender{Client: &http.Client{
		Transport:     transport,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}}
}

// WireHeaders is the header list fetch puts on the wire for the executor's
// headers object sent to target: names lowercased, repeated names joined
// with ", " (as the Headers constructor appends them), then fetch's defaults
// for names absent. Go's client writes them in its own order; an upstream
// reads them by name.
func WireHeaders(target string, h []claudeprep.HeaderField) [][2]string {
	var out [][2]string
	at := map[string]int{}
	for _, f := range h {
		name := strings.ToLower(f.Name)
		if i, ok := at[name]; ok {
			out[i][1] += ", " + f.Value
			continue
		}
		at[name] = len(out)
		out = append(out, [2]string{name, f.Value})
	}
	for _, d := range wireDefaults {
		if _, ok := at[d[0]]; !ok {
			if d[0] == "accept-encoding" {
				d[1] = encodingFor(target)
			}
			out = append(out, d)
		}
	}
	return append(out, [2]string{"connection", "keep-alive"})
}

// ErrNetwork wraps a failure before any response headers: Node's fetch
// throws, and its executor retries and words it its own way, so the request
// goes to Node.
var ErrNetwork = errors.New("upstream: network error")

// Send POSTs req with ctx. The response's body is decoded (gzip); its status
// may be anything. A redirect, a 421 and an encoding other than gzip come
// back as ErrNetwork-wrapped errors: Node's fetch handles them its own way.
func (s *Sender) Send(ctx context.Context, req *claudeprep.Request) (*http.Response, error) {
	// PreflightKey checks these before any send; this holds should a row
	// change mid-request.
	if err := CheckHeaders(req.Header); err != nil {
		return nil, err
	}
	// fetch sends new URL(req.URL): the host lowercased (Host and SNI), a
	// default port dropped.
	target, ok := claudeprep.CanonicalURL(req.URL)
	if !ok {
		return nil, declined("a request URL fetch would parse its own way")
	}
	hr, err := http.NewRequestWithContext(ctx, http.MethodPost, target, bytes.NewReader(req.Body))
	if err != nil {
		return nil, fmt.Errorf("%w: the request URL doesn't parse", ErrNetwork)
	}
	for _, kv := range WireHeaders(req.URL, req.Header) {
		hr.Header[http.CanonicalHeaderKey(kv[0])] = []string{kv[1]}
	}
	resp, err := s.Client.Do(hr)
	if err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		// Not the *url.Error's text: it quotes the URL, query and all.
		var ue *url.Error
		if errors.As(err, &ue) {
			err = ue.Err
		}
		return nil, fmt.Errorf("%w: %v", ErrNetwork, err)
	}
	resp.Body = newIdleBody(resp.Body, bodyIdleTimeout)
	switch st := resp.StatusCode; {
	case st == http.StatusMovedPermanently || st == http.StatusFound || st == http.StatusSeeOther || st == http.StatusTemporaryRedirect || st == http.StatusPermanentRedirect || st == http.StatusMisdirectedRequest:
		resp.Body.Close()
		return nil, fmt.Errorf("%w: status %d (fetch follows or re-sends it)", ErrNetwork, st)
	case st < 200 || st > 599 || st == http.StatusNoContent || st == http.StatusResetContent || st == http.StatusNotModified:
		// Node's Response constructor refuses these with a body (or at all),
		// so chatCore's reply for them is Node's own.
		resp.Body.Close()
		return nil, fmt.Errorf("%w: status %d", ErrNetwork, st)
	}
	switch enc := strings.ToLower(strings.TrimSpace(resp.Header.Get("Content-Encoding"))); enc {
	case "", "identity":
	case "gzip", "x-gzip":
		// Decoded as it is read, as fetch does: the gzip header is the body's
		// first bytes, which may come long after the response headers.
		resp.Body = &gunzip{raw: resp.Body}
		resp.Header.Del("Content-Length")
		resp.ContentLength, resp.Uncompressed = -1, true
	default:
		resp.Body.Close()
		return nil, fmt.Errorf("%w: content-encoding %q", ErrNetwork, enc)
	}
	return resp, nil
}

// connectTimeout is undici's default connect timeout.
const connectTimeout = 10 * time.Second

// bodyIdleTimeout is undici's default bodyTimeout, which Node's fetch keeps
// (proxyFetch.js turns off only the headers timeout): a body silent this long
// fails its read.
const bodyIdleTimeout = 300 * time.Second

// idleBody fails a Read that waits longer than idle for data, by closing the
// body under it. One timer, reset on each Read.
type idleBody struct {
	io.ReadCloser
	idle  time.Duration
	timer *time.Timer
}

func newIdleBody(b io.ReadCloser, idle time.Duration) io.ReadCloser {
	body := &idleBody{ReadCloser: b, idle: idle}
	body.timer = time.AfterFunc(idle, func() { _ = b.Close() })
	body.timer.Stop()
	return body
}

func (b *idleBody) Read(p []byte) (int, error) {
	b.timer.Reset(b.idle)
	n, err := b.ReadCloser.Read(p)
	if !b.timer.Stop() && err == nil {
		err = errors.New("upstream: body timeout")
	}
	return n, err
}

func (b *idleBody) Close() error {
	b.timer.Stop()
	return b.ReadCloser.Close()
}

// gunzip opens the gzip stream on the first Read and inflates it as Node's
// fetch does (zlib with Z_SYNC_FLUSH): a body that ends cleanly inside a
// member, or inside the next member's header, decodes as far as it got and
// ends; one cut by the network fails. After a member zlib stops at a zero
// byte (padding: whatever follows is ignored) and reads anything else as the
// next member, so bytes that aren't one are an error. A member's last decoded
// bytes come back before the next raw byte is waited for.
type gunzip struct {
	raw        io.ReadCloser
	src        *eofSeen
	br         *bufio.Reader
	zr         *gzip.Reader
	started    bool
	memberDone bool
	err        error
}

// gzipReservedFlags are the FLG bits RFC 1952 reserves: zlib fails a header
// with any set ("unknown header flags set"); Go's reader ignores them.
const gzipReservedFlags = 0xe0

// open starts a member where the body is: io.EOF when the body ends before
// or inside its header, an error for bytes that aren't a gzip header. zlib
// checks the header two bytes at a time as they arrive (inflate.c's HEAD and
// FLAGS states: the magic number, then CM and FLG), so a pair that can't
// start a member fails even when the body ends before a whole header, and a
// body that ends inside a pair ends cleanly; Go's reader would ask for all
// ten bytes first. (One difference stays: Go's reader refuses a file name or
// comment of 512 bytes or more, which zlib reads; a reply that carries one
// fails here where Node's decodes.)
func (g *gunzip) open() error {
	// Each pair is checked as soon as it is here, not once all four are.
	if head, _ := g.br.Peek(2); len(head) == 2 && (head[0] != 0x1f || head[1] != 0x8b) {
		return gzip.ErrHeader
	}
	if head, _ := g.br.Peek(4); len(head) == 4 && (head[2] != 0x08 || head[3]&gzipReservedFlags != 0) {
		return gzip.ErrHeader
	}
	var err error
	if g.zr == nil {
		g.zr, err = gzip.NewReader(g.br)
	} else {
		err = g.zr.Reset(g.br)
	}
	switch {
	case err == nil:
		g.zr.Multistream(false)
		return nil
	case (err == io.EOF || err == io.ErrUnexpectedEOF) && g.src.eof:
		return io.EOF
	}
	return err
}

// next is what follows a finished member: the end (the body's, or a zero
// byte), else another member.
func (g *gunzip) next() error {
	b, err := g.br.Peek(1)
	switch {
	case err == io.EOF:
		return io.EOF
	case err != nil:
		return err
	case b[0] == 0:
		return io.EOF
	}
	return g.open()
}

// eofSeen records whether the body under the decoder ended cleanly.
type eofSeen struct {
	r   io.Reader
	eof bool
}

func (e *eofSeen) Read(p []byte) (int, error) {
	n, err := e.r.Read(p)
	if err == io.EOF {
		e.eof = true
	}
	return n, err
}

func (g *gunzip) Read(p []byte) (int, error) {
	if !g.started {
		g.started = true
		g.src = &eofSeen{r: g.raw}
		g.br = bufio.NewReader(g.src)
		g.err = g.open()
	}
	for g.err == nil {
		if g.memberDone {
			g.memberDone = false
			g.err = g.next()
			continue
		}
		n, err := g.zr.Read(p)
		switch {
		case err == io.EOF:
			g.memberDone = true
		case err == io.ErrUnexpectedEOF && g.src.eof:
			g.err = io.EOF
		case err != nil:
			g.err = err
		}
		if n > 0 {
			return n, nil
		}
	}
	return 0, g.err
}

func (g *gunzip) Close() error { return g.raw.Close() }
