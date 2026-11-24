// Package drain is the gateway's side of server-drain.js: which requests hold
// a graceful shutdown open (model traffic), which are closed when it starts
// (dashboard streams that never end), and the 503 every request arriving
// during it gets.
package drain

import (
	"context"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"unicode/utf8"
)

// RetryAfterSeconds is server-drain.js's RETRY_AFTER_SECONDS.
const RetryAfterSeconds = 5

// Model traffic and the never-ending streams, as the socket sees them (before
// Next's rewrites, which match without regard to case). The same expressions
// as MODEL_TRAFFIC and LONG_LIVED in server-drain.js.
var (
	modelTraffic = regexp.MustCompile(`(?i)^/(?:api/)?v1(?:beta)?(?:/|$)|^/(?:codex|backend-api/codex)(?:/|$)|^/(?:responses|systemone)/?$`)
	longLived    = []*regexp.Regexp{
		regexp.MustCompile(`(?i)^/api/usage/stream/?$`),
		regexp.MustCompile(`(?i)^/api/translator/console-logs/stream/?$`),
		regexp.MustCompile(`(?i)^/api/mcp/[^/]+/sse/?$`),
	}
)

// PathOf is the path a request target routes to, as server-drain.js's pathOf
// computes it with the WHATWG URL parser: origin-form or absolute-form, dot
// segments resolved (also percent-encoded ones), backslashes read as slashes,
// then percent-decoded the way decodeURIComponent does (kept as is when that
// fails).
func PathOf(target string) string {
	t := strings.Map(func(r rune) rune {
		if r == '\t' || r == '\n' || r == '\r' {
			return -1
		}
		return r
	}, strings.TrimFunc(target, func(r rune) bool { return r <= ' ' }))
	if t == "" {
		t = "/"
	}
	t = strings.ReplaceAll(t, `\`, "/")
	lower := strings.ToLower(t)
	switch {
	case strings.HasPrefix(lower, "http://") || strings.HasPrefix(lower, "https://"):
		t = t[strings.Index(t, ":")+1:]
		t = strings.TrimLeft(t, "/")
		t = authorityless(t)
	case strings.HasPrefix(t, "//"):
		t = authorityless(strings.TrimLeft(t, "/"))
	}
	if i := strings.IndexAny(t, "?#"); i != -1 {
		t = t[:i]
	}
	segments := strings.Split(strings.TrimPrefix(t, "/"), "/")
	out := make([]string, 0, len(segments))
	for i, seg := range segments {
		last := i == len(segments)-1
		switch strings.ToLower(seg) {
		case ".", "%2e":
			if last {
				out = append(out, "")
			}
		case "..", ".%2e", "%2e.", "%2e%2e":
			if len(out) > 0 {
				out = out[:len(out)-1]
			}
			if last {
				out = append(out, "")
			}
		default:
			out = append(out, seg)
		}
	}
	pathname := "/" + strings.Join(out, "/")
	decoded, err := url.PathUnescape(pathname)
	if err != nil || !utf8.ValidString(decoded) {
		return pathname
	}
	return decoded
}

// authorityless drops the host[:port] in front of an absolute-form path.
func authorityless(rest string) string {
	if i := strings.IndexAny(rest, "/?#"); i != -1 {
		return rest[i:]
	}
	return "/"
}

// IsModelTraffic: a request that holds the drain open.
func IsModelTraffic(target string) bool { return modelTraffic.MatchString(PathOf(target)) }

// IsLongLived: a stream that only ends when the client leaves, closed when the
// drain starts.
func IsLongLived(target string) bool {
	p := PathOf(target)
	for _, re := range longLived {
		if re.MatchString(p) {
			return true
		}
	}
	return false
}

// Tracker counts model requests in flight and holds the long-lived ones.
type Tracker struct {
	mu        sync.Mutex
	draining  bool
	active    int
	longLived map[*int]context.CancelFunc
	changed   chan struct{}
}

// NewTracker returns an empty tracker.
func NewTracker() *Tracker {
	return &Tracker{longLived: map[*int]context.CancelFunc{}, changed: make(chan struct{}, 1)}
}

func (t *Tracker) notify() {
	select {
	case t.changed <- struct{}{}:
	default:
	}
}

// Admit is server-drain.js's track(): call it at the start of every request.
// It returns false once the drain has started, and the caller answers with
// Reject. Otherwise it returns the request to serve (with a context the drain
// cancels, for a long-lived stream) and a done func to call when it ends.
// Upgrades are admitted without being counted: a WebSocket turn holds the app
// server's own drain, and the gateway waits for that process.
func (t *Tracker) Admit(r *http.Request) (*http.Request, func(), bool) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.draining {
		return r, func() {}, false
	}
	if r.Header.Get("Upgrade") != "" {
		return r, func() {}, true
	}
	target := r.RequestURI
	if target == "" {
		target = r.URL.RequestURI()
	}
	if IsModelTraffic(target) {
		t.active++
		var once sync.Once
		return r, func() {
			once.Do(func() {
				t.mu.Lock()
				t.active--
				t.mu.Unlock()
				t.notify()
			})
		}, true
	}
	if IsLongLived(target) {
		ctx, cancel := context.WithCancel(r.Context())
		key := new(int)
		t.longLived[key] = cancel
		return r.WithContext(ctx), func() {
			t.mu.Lock()
			delete(t.longLived, key)
			t.mu.Unlock()
			cancel()
		}, true
	}
	return r, func() {}, true
}

// Begin starts the drain: every later Admit is refused and the long-lived
// streams are closed. It reports false when the drain had already started.
func (t *Tracker) Begin() bool {
	t.mu.Lock()
	if t.draining {
		t.mu.Unlock()
		return false
	}
	t.draining = true
	cancels := make([]context.CancelFunc, 0, len(t.longLived))
	for _, cancel := range t.longLived {
		cancels = append(cancels, cancel)
	}
	t.mu.Unlock()
	for _, cancel := range cancels {
		cancel()
	}
	t.notify()
	return true
}

// Draining reports whether Begin ran.
func (t *Tracker) Draining() bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.draining
}

// Inflight is the number of model requests in flight.
func (t *Tracker) Inflight() int {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.active
}

// WaitIdle returns once no model request is in flight, or with ctx's error.
func (t *Tracker) WaitIdle(ctx context.Context) error {
	for {
		if t.Inflight() == 0 {
			return nil
		}
		select {
		case <-t.changed:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
}

var rejectBody = []byte(`{"error":{"message":"Server is restarting; retry shortly.","type":"server_error","code":"server_draining"}}`)

// Reject answers a request that arrived during the drain the way
// server-drain.js does: a 503 with Retry-After, closing the connection. An
// upgrade gets the bare 503 rejectUpgrade writes.
func Reject(w http.ResponseWriter, r *http.Request) {
	h := w.Header()
	h.Set("Retry-After", strconv.Itoa(RetryAfterSeconds))
	h.Set("Connection", "close")
	if r.Header.Get("Upgrade") != "" {
		h.Set("Content-Length", "0")
		w.WriteHeader(http.StatusServiceUnavailable)
		return
	}
	h.Set("Content-Type", "application/json")
	h.Set("Content-Length", strconv.Itoa(len(rejectBody)))
	w.WriteHeader(http.StatusServiceUnavailable)
	_, _ = w.Write(rejectBody)
}
