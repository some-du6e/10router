package drain

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// The cases tests/unit/server-drain.test.js holds isModelTraffic and
// isLongLived to.
func TestModelTraffic(t *testing.T) {
	for _, target := range []string{"/v1/chat/completions", "/v1", "/v1?x=1", "/v1/v1/messages", "/api/v1/messages?beta=true",
		"/v1beta/models/x:streamGenerateContent", "/api/v1beta/models", "/codex/responses", "/backend-api/codex/responses",
		"/responses", "/responses?x=1", "/systemone",
		"/V1/chat/completions", "/Responses", "/Codex/responses", "/API/V1/messages",
		"http://example.test/v1/chat/completions", "https://example.test:8443/responses?x=1",
		"/./v1/chat/completions", "/api/usage/../../v1/messages", "/dashboard/%2e%2e/v1/models",
		"/api/v%31/chat/completions", "/%76%31/messages", `/v1\messages`} {
		if !IsModelTraffic(target) {
			t.Errorf("IsModelTraffic(%q) = false (path %q)", target, PathOf(target))
		}
	}
	for _, target := range []string{"/dashboard", "/api/usage/stream", "/api/health", "/api/v10", "/v1x", "/responsesx",
		"http://example.test/dashboard", "http://example.test",
		"/v1/%2e%2e/api/usage/stream", "/v1/../api/usage/stream", "/v1/%2E%2E/dashboard", "", "/%ff/v1"} {
		if IsModelTraffic(target) {
			t.Errorf("IsModelTraffic(%q) = true (path %q)", target, PathOf(target))
		}
	}
}

func TestLongLived(t *testing.T) {
	for _, target := range []string{"/api/usage/stream", "/api/translator/console-logs/stream", "/api/mcp/browser/sse?x=1",
		"/API/Usage/Stream", "/API/Translator/Console-Logs/Stream", "/Api/MCP/browser/SSE",
		"/v1/%2e%2e/api/usage/stream", "/v1/../api/mcp/browser/sse"} {
		if !IsLongLived(target) {
			t.Errorf("IsLongLived(%q) = false (path %q)", target, PathOf(target))
		}
	}
	if IsLongLived("/api/usage/history") {
		t.Error("IsLongLived(/api/usage/history)")
	}
}

func TestPathOf(t *testing.T) {
	for target, want := range map[string]string{
		"":                 "/",
		"/a/b/.":           "/a/b/",
		"/a/b/..":          "/a/",
		"/../..":           "/",
		"/a%2Fb":           "/a/b",
		"/a%zz":            "/a%zz",
		"http://h:1":       "/",
		"http://h/x?y#z":   "/x",
		"/x#frag":          "/x",
		"/a/%2E/b":         "/a/b",
		"/a/.%2e/b":        "/b",
		"  /v1/models  ":   "/v1/models",
		"/v\t1/mod\nels\r": "/v1/models",
	} {
		if got := PathOf(target); got != want {
			t.Errorf("PathOf(%q) = %q, want %q", target, got, want)
		}
	}
}

func request(target string) *http.Request {
	r := httptest.NewRequest("POST", target, nil)
	return r
}

func TestTrackerCountsModelTrafficOnly(t *testing.T) {
	tr := NewTracker()
	_, doneModel, ok := tr.Admit(request("/v1/messages"))
	if !ok {
		t.Fatal("refused before the drain")
	}
	_, doneDash, _ := tr.Admit(request("/dashboard"))
	ws := request("/backend-api/codex/responses")
	ws.Header.Set("Upgrade", "websocket")
	_, doneWS, _ := tr.Admit(ws)
	if tr.Inflight() != 1 {
		t.Fatalf("inflight %d, want 1", tr.Inflight())
	}
	doneDash()
	doneWS()
	doneModel()
	doneModel() // idempotent
	if tr.Inflight() != 0 {
		t.Fatalf("inflight %d after done", tr.Inflight())
	}
}

func TestBeginRefusesAndClosesLongLived(t *testing.T) {
	tr := NewTracker()
	stream, doneStream, _ := tr.Admit(request("/api/usage/stream"))
	_, doneModel, _ := tr.Admit(request("/v1/messages"))
	if !tr.Begin() {
		t.Fatal("Begin reported an earlier drain")
	}
	if tr.Begin() {
		t.Fatal("second Begin reported a new drain")
	}
	select {
	case <-stream.Context().Done():
	case <-time.After(time.Second):
		t.Fatal("the long-lived stream was not closed")
	}
	doneStream()
	if _, _, ok := tr.Admit(request("/v1/messages")); ok {
		t.Fatal("admitted during the drain")
	}
	idle := make(chan error, 1)
	go func() { idle <- tr.WaitIdle(context.Background()) }()
	select {
	case <-idle:
		t.Fatal("idle with a model request in flight")
	case <-time.After(100 * time.Millisecond):
	}
	doneModel()
	select {
	case err := <-idle:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("WaitIdle did not return")
	}
}

func TestReject(t *testing.T) {
	w := httptest.NewRecorder()
	Reject(w, request("/v1/messages"))
	body, _ := io.ReadAll(w.Result().Body)
	if w.Code != 503 || w.Header().Get("Retry-After") != "5" || w.Header().Get("Connection") != "close" ||
		!strings.Contains(string(body), `"code":"server_draining"`) || w.Header().Get("Content-Type") != "application/json" {
		t.Fatalf("got %d %v %s", w.Code, w.Header(), body)
	}

	up := request("/backend-api/codex/responses")
	up.Header.Set("Upgrade", "websocket")
	w = httptest.NewRecorder()
	Reject(w, up)
	if w.Code != 503 || w.Body.Len() != 0 || w.Header().Get("Content-Length") != "0" {
		t.Fatalf("upgrade got %d %v %q", w.Code, w.Header(), w.Body.String())
	}
}
