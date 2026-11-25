package nodeevents

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestBetasLearned(t *testing.T) {
	var got map[string]any
	status := http.StatusNoContent
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != Path || r.Header.Get(TokenHeader) != "tok" || r.Header.Get("Content-Type") != "application/json" {
			w.WriteHeader(http.StatusTeapot)
			return
		}
		// A direct call: none of the relay's peer headers.
		for name := range r.Header {
			if strings.HasPrefix(strings.ToLower(name), "x-9r-gw-peer") {
				w.WriteHeader(http.StatusTeapot)
				return
			}
		}
		raw, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(raw, &got)
		w.WriteHeader(status)
		_, _ = w.Write([]byte(`{"error":"No such connection for that provider"}`))
	}))
	defer srv.Close()
	c := &Client{Base: srv.URL, Token: "tok", HTTP: srv.Client()}
	if err := c.BetasLearned(context.Background(), "k1", "openai-compatible-chat-hot", []string{"flag-a"}); err != nil {
		t.Fatal(err)
	}
	if got["type"] != "betas-learned" || got["connectionId"] != "k1" || got["provider"] != "openai-compatible-chat-hot" {
		t.Fatalf("event %v", got)
	}
	status = http.StatusNotFound
	err := c.BetasLearned(context.Background(), "k1", "openai-compatible-chat-hot", []string{"flag-a"})
	if err == nil || !strings.Contains(err.Error(), "404") || !strings.Contains(err.Error(), "No such connection") {
		t.Fatalf("want the app server's 404, got %v", err)
	}
}

func TestNewTalksToLoopback(t *testing.T) {
	if c := New(20129, "tok"); c.Base != "http://127.0.0.1:20129" || c.Token != "tok" {
		t.Fatalf("%+v", c)
	}
}
