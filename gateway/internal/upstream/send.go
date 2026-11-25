package upstream

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
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
	dialer := &net.Dialer{Timeout: 10 * time.Second, KeepAlive: 30 * time.Second}
	transport := &http.Transport{
		Proxy:                  nil,
		DialContext:            dialer.DialContext,
		ForceAttemptHTTP2:      false,
		TLSNextProto:           map[string]func(string, *tls.Conn) http.RoundTripper{},
		TLSHandshakeTimeout:    10 * time.Second,
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
	hr, err := http.NewRequestWithContext(ctx, http.MethodPost, req.URL, bytes.NewReader(req.Body))
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrNetwork, err)
	}
	for _, kv := range WireHeaders(req.URL, req.Header) {
		hr.Header[http.CanonicalHeaderKey(kv[0])] = []string{kv[1]}
	}
	resp, err := s.Client.Do(hr)
	if err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, fmt.Errorf("%w: %v", ErrNetwork, err)
	}
	switch resp.StatusCode {
	case http.StatusMovedPermanently, http.StatusFound, http.StatusSeeOther, http.StatusTemporaryRedirect, http.StatusPermanentRedirect, http.StatusMisdirectedRequest:
		resp.Body.Close()
		return nil, fmt.Errorf("%w: status %d (fetch follows or re-sends it)", ErrNetwork, resp.StatusCode)
	}
	switch enc := strings.ToLower(strings.TrimSpace(resp.Header.Get("Content-Encoding"))); enc {
	case "", "identity":
	case "gzip", "x-gzip":
		// Decoded as it is read, as fetch does: the gzip header is the body's
		// first bytes, which may come long after the response headers.
		resp.Body = &gunzip{raw: resp.Body}
		resp.Header.Del("Content-Length")
	default:
		resp.Body.Close()
		return nil, fmt.Errorf("%w: content-encoding %q", ErrNetwork, enc)
	}
	return resp, nil
}

// gunzip opens the gzip stream on the first Read.
type gunzip struct {
	raw io.ReadCloser
	zr  *gzip.Reader
	err error
}

func (g *gunzip) Read(p []byte) (int, error) {
	if g.zr == nil && g.err == nil {
		g.zr, g.err = gzip.NewReader(g.raw)
	}
	if g.err != nil {
		return 0, g.err
	}
	return g.zr.Read(p)
}

func (g *gunzip) Close() error { return g.raw.Close() }
