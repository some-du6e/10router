package proxy

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// stack is an upstream (standing in for the Node app server) behind a Proxy.
type stack struct {
	upstream *httptest.Server
	front    *httptest.Server
}

func newStack(t *testing.T, upstream http.Handler, o Options) *stack {
	t.Helper()
	up := httptest.NewServer(upstream)
	t.Cleanup(up.Close)
	u, _ := url.Parse(up.URL)
	o.Upstream = u
	if o.Transport == nil {
		o.Transport = NewTransport(20 * time.Second)
	}
	front := httptest.NewServer(New(o))
	t.Cleanup(front.Close)
	return &stack{upstream: up, front: front}
}

func TestSSEFlushesEachEvent(t *testing.T) {
	const events = 5
	const gap = 300 * time.Millisecond
	sent := make(chan time.Time, events)
	s := newStack(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(200)
		for i := 0; i < events; i++ {
			fmt.Fprintf(w, "event: delta\ndata: {\"i\":%d}\n\n", i)
			w.(http.Flusher).Flush()
			sent <- time.Now()
			time.Sleep(gap)
		}
	}), Options{})

	res, err := http.Post(s.front.URL+"/v1/messages", "application/json", strings.NewReader(`{"stream":true}`))
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	reader := bufio.NewReader(res.Body)
	for i := 0; i < events; i++ {
		// Each event is two lines and a blank one.
		for j := 0; j < 3; j++ {
			if _, err := reader.ReadString('\n'); err != nil {
				t.Fatalf("event %d: %v", i, err)
			}
		}
		at := time.Now()
		lag := at.Sub(<-sent)
		// Well under the gap: the event came before the next was written.
		if lag > gap/2 {
			t.Fatalf("event %d arrived %v after it was written", i, lag)
		}
	}
}

func TestFourMegabyteBodiesStreamBothWays(t *testing.T) {
	const size = 4 << 20
	firstMB := make(chan struct{})
	s := newStack(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := sha256.New()
		buf := make([]byte, 64<<10)
		var n int64
		signalled := false
		for {
			k, err := r.Body.Read(buf)
			h.Write(buf[:k])
			n += int64(k)
			if !signalled && n >= 1<<20 {
				close(firstMB)
				signalled = true
			}
			if err == io.EOF {
				break
			}
			if err != nil {
				t.Errorf("upstream read: %v", err)
				return
			}
		}
		w.Header().Set("X-Body-Sha256", hex.EncodeToString(h.Sum(nil)))
		w.Header().Set("X-Body-Bytes", fmt.Sprint(n))
		// And 4 MB back.
		_, _ = io.Copy(w, io.LimitReader(zeros{}, size))
	}), Options{RequestTimeout: 30 * time.Second})

	body := bytes.Repeat([]byte("0123456789abcdef"), size/16)
	sum := sha256.Sum256(body)
	pr, pw := io.Pipe()
	go func() {
		// The first megabyte, then nothing until the upstream has it: a proxy
		// that buffered the whole body would never get there.
		_, _ = pw.Write(body[:1<<20])
		select {
		case <-firstMB:
		case <-time.After(10 * time.Second):
			pw.CloseWithError(fmt.Errorf("upstream never saw the first megabyte"))
			return
		}
		_, _ = pw.Write(body[1<<20:])
		pw.Close()
	}()
	req, _ := http.NewRequest("POST", s.front.URL+"/v1/messages", pr)
	req.ContentLength = size
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	got, _ := io.Copy(io.Discard, res.Body)
	if res.Header.Get("X-Body-Sha256") != hex.EncodeToString(sum[:]) || res.Header.Get("X-Body-Bytes") != fmt.Sprint(size) {
		t.Fatalf("upstream got %s bytes, sha %s", res.Header.Get("X-Body-Bytes"), res.Header.Get("X-Body-Sha256"))
	}
	if got != size {
		t.Fatalf("client got %d bytes back", got)
	}
}

func discardLogger() *log.Logger { return log.New(io.Discard, "", 0) }

type zeros struct{}

func (zeros) Read(p []byte) (int, error) {
	clear(p)
	return len(p), nil
}

func TestClientAbortReachesUpstream(t *testing.T) {
	upstreamGone := make(chan struct{})
	started := make(chan struct{})
	s := newStack(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(200)
		w.(http.Flusher).Flush()
		close(started)
		<-r.Context().Done()
		close(upstreamGone)
	}), Options{})

	ctx, cancel := context.WithCancel(context.Background())
	req, _ := http.NewRequestWithContext(ctx, "POST", s.front.URL+"/v1/messages", strings.NewReader("{}"))
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	<-started
	cancel()
	res.Body.Close()
	select {
	case <-upstreamGone:
	case <-time.After(5 * time.Second):
		t.Fatal("the upstream request outlived the client")
	}
}

func TestWebSocketUpgradePassesThrough(t *testing.T) {
	var sawUpgrade atomic.Value
	s := newStack(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sawUpgrade.Store(r.Header.Get("Upgrade") + "|" + r.Header.Get("Connection") + "|" + r.Header.Get("Sec-Websocket-Key") + "|" + r.Host)
		conn, rw, err := http.NewResponseController(w).Hijack()
		if err != nil {
			t.Error(err)
			return
		}
		defer conn.Close()
		_, _ = rw.WriteString("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: x\r\n\r\n")
		_ = rw.Flush()
		// Echo until the client closes.
		_, _ = io.Copy(conn, rw)
	}), Options{})

	conn, err := net.Dial("tcp", s.front.Listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(5 * time.Second))
	fmt.Fprintf(conn, "GET /backend-api/codex/responses HTTP/1.1\r\nHost: router.example.test\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n")
	br := bufio.NewReader(conn)
	res, err := http.ReadResponse(br, nil)
	if err != nil {
		t.Fatal(err)
	}
	if res.StatusCode != 101 {
		t.Fatalf("status %d", res.StatusCode)
	}
	if got := sawUpgrade.Load().(string); got != "websocket|Upgrade|dGhlIHNhbXBsZSBub25jZQ==|router.example.test" {
		t.Fatalf("upstream saw %q", got)
	}
	frame := "a frame of bytes, both ways"
	fmt.Fprint(conn, frame)
	echo := make([]byte, len(frame))
	if _, err := io.ReadFull(br, echo); err != nil || string(echo) != frame {
		t.Fatalf("echo %q, %v", echo, err)
	}
}

func TestHeadersAndPeer(t *testing.T) {
	seen := make(chan *http.Request, 1)
	s := newStack(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen <- r.Clone(context.Background())
		w.Header().Set("Keep-Alive", "timeout=5")
		w.Header().Set("X-Kept", "yes")
		w.WriteHeader(204)
	}), Options{PeerToken: "t0ken-t0ken-t0ken-t0ken-t0ken-t0"})

	req, _ := http.NewRequest("POST", s.front.URL+"/v1/messages?beta=true", strings.NewReader("{}"))
	req.Host = "router.example.test"
	req.Header.Set("X-Forwarded-For", "198.51.100.1, 127.0.0.1")
	req.Header.Set("X-Forwarded-Proto", "https")
	req.Header.Set("X-Forwarded-Host", "router.example.test")
	req.Header.Set("Forwarded", "for=198.51.100.1")
	req.Header.Set("X-Real-Ip", "198.51.100.2")
	req.Header.Set("X-9r-Gw-Token", "forged")
	req.Header.Set("X-9r-Gw-Peer-Ip", "127.0.0.1")
	req.Header.Set("X-9r-Real-Ip", "127.0.0.1")
	req.Header.Set("Authorization", "Bearer sk-client")
	req.Header.Set("Anthropic-Beta", "a,b")
	req.Header.Set("Connection", "X-Client-Hop")
	req.Header.Set("X-Client-Hop", "1")
	req.Header.Set("Proxy-Connection", "keep-alive")
	// A client that sends no Accept-Encoding of its own.
	res, err := (&http.Transport{DisableCompression: true}).RoundTrip(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	r := <-seen

	if r.Host != "router.example.test" {
		t.Errorf("Host = %q", r.Host)
	}
	if r.URL.RequestURI() != "/v1/messages?beta=true" {
		t.Errorf("target = %q", r.URL.RequestURI())
	}
	for name, want := range map[string]string{
		// Forwarding headers pass through as sent; the app's rule decides.
		"X-Forwarded-For":   "198.51.100.1, 127.0.0.1",
		"X-Forwarded-Proto": "https",
		"X-Forwarded-Host":  "router.example.test",
		"Forwarded":         "for=198.51.100.1",
		"X-Real-Ip":         "198.51.100.2",
		// The peer is the client socket, proven by the gateway's token.
		"X-9r-Gw-Token":   "t0ken-t0ken-t0ken-t0ken-t0ken-t0",
		"X-9r-Gw-Peer-Ip": "127.0.0.1",
		// Stamps of the app's own are its to replace; they pass through.
		"X-9r-Real-Ip":   "127.0.0.1",
		"Authorization":  "Bearer sk-client",
		"Anthropic-Beta": "a,b",
		// Hop-by-hop headers stop here.
		"X-Client-Hop":     "",
		"Proxy-Connection": "",
		// No transparent gzip on the loopback hop.
		"Accept-Encoding": "",
	} {
		if got := strings.Join(r.Header.Values(name), ", "); got != want {
			t.Errorf("upstream %s = %q, want %q", name, got, want)
		}
	}
	if r.Header.Get("X-9r-Gw-Peer-Port") == "" {
		t.Error("no peer port")
	}
	if res.Header.Get("X-Kept") != "yes" || res.Header.Get("Keep-Alive") != "" {
		t.Errorf("response headers %v", res.Header)
	}
}

func TestNoPeerHeadersWithoutToken(t *testing.T) {
	seen := make(chan http.Header, 1)
	s := newStack(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen <- r.Header.Clone()
	}), Options{})
	req, _ := http.NewRequest("GET", s.front.URL+"/v1/models", nil)
	req.Header.Set("X-9r-Gw-Token", "forged")
	req.Header.Set("X-9r-Gw-Peer-Ip", "203.0.113.1")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	h := <-seen
	if h.Get("X-9r-Gw-Token") != "" || h.Get("X-9r-Gw-Peer-Ip") != "" {
		t.Fatalf("forged peer headers reached the app: %v", h)
	}
}

func TestAcceptEncodingIsTheClients(t *testing.T) {
	seen := make(chan string, 1)
	s := newStack(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen <- r.Header.Get("Accept-Encoding")
		w.Header().Set("Content-Encoding", "gzip")
		_, _ = w.Write([]byte("not really gzip"))
	}), Options{})
	req, _ := http.NewRequest("GET", s.front.URL+"/v1/models", nil)
	req.Header.Set("Accept-Encoding", "gzip, br")
	// A transport that leaves the body encoded, like a client that asked for it.
	res, err := (&http.Transport{DisableCompression: true}).RoundTrip(req)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(res.Body)
	res.Body.Close()
	if got := <-seen; got != "gzip, br" {
		t.Errorf("upstream Accept-Encoding = %q", got)
	}
	if string(body) != "not really gzip" || res.Header.Get("Content-Encoding") != "gzip" {
		t.Errorf("body %q encoding %q: the proxy decoded or re-encoded", body, res.Header.Get("Content-Encoding"))
	}
}

func TestH2CUpgradeServedAsHTTP1(t *testing.T) {
	seen := make(chan http.Header, 1)
	s := newStack(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen <- r.Header.Clone()
		_, _ = io.WriteString(w, "ok")
	}), Options{})
	conn, err := net.Dial("tcp", s.front.Listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(5 * time.Second))
	fmt.Fprintf(conn, "POST /v1/messages HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade, HTTP2-Settings\r\nUpgrade: h2c\r\nHTTP2-Settings: AAMAAABkAARAAAAAAAIAAAAA\r\nContent-Length: 2\r\n\r\n{}")
	res, err := http.ReadResponse(bufio.NewReader(conn), nil)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(res.Body)
	if res.StatusCode != 200 || string(body) != "ok" {
		t.Fatalf("status %d body %q", res.StatusCode, body)
	}
	if !res.Close {
		t.Error("an h2c-downgraded connection should close after the reply, as custom-server.js does")
	}
	h := <-seen
	if h.Get("Upgrade") != "" || h.Get("Http2-Settings") != "" {
		t.Errorf("upstream saw the h2c upgrade: %v", h)
	}
}

func TestSlowBodyGets408(t *testing.T) {
	upstreamErr := make(chan error, 1)
	s := newStack(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, err := io.Copy(io.Discard, r.Body)
		upstreamErr <- err
	}), Options{RequestTimeout: 300 * time.Millisecond})
	conn, err := net.Dial("tcp", s.front.Listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(5 * time.Second))
	fmt.Fprintf(conn, "POST /v1/messages HTTP/1.1\r\nHost: localhost\r\nContent-Length: 100\r\n\r\n{\"partial\":")
	res, err := http.ReadResponse(bufio.NewReader(conn), nil)
	if err != nil {
		t.Fatal(err)
	}
	if res.StatusCode != http.StatusRequestTimeout {
		t.Fatalf("status %d", res.StatusCode)
	}
	select {
	case err := <-upstreamErr:
		if err == nil {
			t.Error("the upstream got a complete body")
		}
	case <-time.After(5 * time.Second):
		t.Error("the upstream request was not cut")
	}
}

func TestBodyDeadlineDoesNotCutTheStream(t *testing.T) {
	s := newStack(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		w.Header().Set("Content-Type", "text/event-stream")
		for i := 0; i < 4; i++ {
			fmt.Fprintf(w, "data: %d\n\n", i)
			w.(http.Flusher).Flush()
			time.Sleep(200 * time.Millisecond)
		}
	}), Options{RequestTimeout: 300 * time.Millisecond})
	res, err := http.Post(s.front.URL+"/v1/messages", "application/json", strings.NewReader("{}"))
	if err != nil {
		t.Fatal(err)
	}
	body, err := io.ReadAll(res.Body)
	res.Body.Close()
	if err != nil || strings.Count(string(body), "data: ") != 4 {
		t.Fatalf("stream cut after %q: %v", body, err)
	}
}

func TestUnreachableAppIs502(t *testing.T) {
	ln, _ := net.Listen("tcp", "127.0.0.1:0")
	addr := ln.Addr().String()
	ln.Close()
	front := httptest.NewServer(New(Options{Upstream: &url.URL{Scheme: "http", Host: addr}, Logger: discardLogger()}))
	defer front.Close()
	res, err := http.Get(front.URL + "/v1/models")
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(res.Body)
	res.Body.Close()
	if res.StatusCode != 502 || !strings.Contains(string(body), "gateway_upstream_unavailable") {
		t.Fatalf("status %d body %s", res.StatusCode, body)
	}
}

func TestPeerOf(t *testing.T) {
	for _, c := range []struct {
		remote string
		v6     bool
		ip     string
		port   string
	}{
		{"203.0.113.7:51000", false, "203.0.113.7", "51000"},
		{"203.0.113.7:51000", true, "::ffff:203.0.113.7", "51000"},
		{"[::ffff:203.0.113.7]:51000", false, "203.0.113.7", "51000"},
		{"[2001:db8::1]:443", true, "2001:db8::1", "443"},
		{"[::1]:9", false, "::1", "9"},
		{"not-an-addr", false, "not-an-addr", ""},
	} {
		ip, port := PeerOf(c.remote, c.v6)
		if ip != c.ip || port != c.port {
			t.Errorf("PeerOf(%q, %v) = %q, %q; want %q, %q", c.remote, c.v6, ip, port, c.ip, c.port)
		}
	}
}
