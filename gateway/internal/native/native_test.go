package native

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/some-du6e/10router/gateway/internal/claudeprep"
	"github.com/some-du6e/10router/gateway/internal/clientip"
	"github.com/some-du6e/10router/gateway/internal/db"
	"github.com/some-du6e/10router/gateway/internal/db/dbtest"
	"github.com/some-du6e/10router/gateway/internal/db/jsjson"
	"github.com/some-du6e/10router/gateway/internal/decline"
	"github.com/some-du6e/10router/gateway/internal/nodeevents"
	"github.com/some-du6e/10router/gateway/internal/upstream"
)

const nodeData = `{"prefix":"%s","apiType":"chat","baseUrl":"https://gateway.example.test/v1"}`

func conn(id, provider string) map[string]any {
	return map[string]any{
		"id": id, "provider": provider, "authType": "apikey", "name": id, "priority": 1, "isActive": 1,
		"data":      `{"apiKey":"key-` + id + `","providerSpecificData":{"apiType":"chat","baseUrl":"https://gateway.example.test/v1","modelRoutes":{"m1":"anthropic","m2":"anthropic"}}}`,
		"createdAt": "2026-03-01T11:00:00.000Z", "updatedAt": "2026-03-01T11:00:00.000Z",
	}
}

func node(prefix string) map[string]any {
	return map[string]any{
		"id": "openai-compatible-chat-" + prefix, "type": "openai-compatible", "name": prefix,
		"data":      strings.Replace(nodeData, "%s", prefix, 1),
		"createdAt": "2026-03-01T10:00:00.000Z", "updatedAt": "2026-03-01T10:00:00.000Z",
	}
}

// open is a database with two nodes, three keys and two combos, watched so
// its snapshot is loaded, as the gateway keeps it.
func open(t *testing.T, settings string) *db.DB {
	t.Helper()
	path, raw := dbtest.New(t, dbtest.Options{})
	dbtest.InsertRows(t, raw, map[string][]map[string]any{
		"providerNodes": {node("hot"), node("cold")},
		"combos": {
			{"id": "combo-main", "name": "main", "models": `["hot/m1","cold/m1"]`, "createdAt": "2026-03-01T10:00:00.000Z", "updatedAt": "2026-03-01T10:00:00.000Z"},
			{"id": "combo-outer", "name": "outer", "models": `["main","hot/m2","hot/m1"]`, "createdAt": "2026-03-01T10:00:00.000Z", "updatedAt": "2026-03-01T10:00:00.000Z"},
		},
		"providerConnections": {conn("k1", "openai-compatible-chat-hot"), conn("k2", "openai-compatible-chat-hot"), conn("c1", "openai-compatible-chat-cold")},
	})
	dbtest.Exec(t, raw, `INSERT INTO settings(id, data) VALUES(1, ?)`, settings)
	d, err := db.Open(path, db.Options{})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(func() { cancel(); d.Close() })
	if err := d.Watch(ctx, db.WatchOptions{}); err != nil {
		t.Fatal(err)
	}
	if d.Snapshot() == nil {
		t.Fatal("no snapshot")
	}
	return d
}

func noEnv(string) string { return "" }

func ccIncoming() Incoming {
	h := http.Header{}
	h.Set("Content-Type", "application/json")
	h.Set("User-Agent", "claude-cli/2.1.258 (external, cli)")
	h.Set("X-App", "cli")
	h.Set("Anthropic-Version", "2023-06-01")
	return Incoming{Header: h, Host: "localhost:20128", PeerIP: "127.0.0.1"}
}

func body(t *testing.T, model string, extra map[string]any) []byte {
	t.Helper()
	b := map[string]any{
		"model": model, "max_tokens": 1024, "stream": true,
		"messages": []any{map[string]any{"role": "user", "content": "Explain the build failure in step three."}},
	}
	for k, v := range extra {
		b[k] = v
	}
	raw, err := json.Marshal(b)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func TestPlanWalksTheTreeAndPreparesEachKey(t *testing.T) {
	d := open(t, `{"requireApiKey":false}`)
	n := New(d, clientip.NewRule(""), noEnv, "")
	ctx := context.Background()
	p, err := n.Plan(ctx, ccIncoming(), body(t, "outer", nil))
	if err != nil {
		t.Fatal(err)
	}
	want := []Leaf{{"openai-compatible-chat-hot", "m1"}, {"openai-compatible-chat-cold", "m1"}, {"openai-compatible-chat-hot", "m2"}}
	if len(p.Leaves) != len(want) {
		t.Fatalf("leaves %v, want %v", p.Leaves, want)
	}
	for i := range want {
		if p.Leaves[i] != want[i] {
			t.Fatalf("leaves %v, want %v", p.Leaves, want)
		}
	}
	if p.ClientHeaders["x-app"] != "cli" || p.ClientHeaders["host"] != "localhost:20128" {
		t.Fatalf("client headers %v", p.ClientHeaders)
	}
	c, err := d.ConnectionByID(ctx, "k2")
	if err != nil {
		t.Fatal(err)
	}
	prepare, err := n.Prepare(p, p.Leaves[0], c)
	if err != nil {
		t.Fatal(err)
	}
	req, err := prepare(mustNode(t, c))
	if err != nil {
		t.Fatal(err)
	}
	if req.URL != "https://gateway.example.test/v1/messages" {
		t.Fatalf("URL %s", req.URL)
	}
	found := false
	for _, f := range req.Header {
		if strings.Contains(f.Value, "key-k2") {
			found = true
		}
	}
	if !found {
		t.Fatalf("no header carries the key: %v", req.Header)
	}
	if !strings.Contains(string(req.Body), `"model":"m1"`) {
		t.Fatalf("body %s", req.Body)
	}
}

func mustNode(t *testing.T, c *db.Connection) claudeprep.NodeSettings {
	t.Helper()
	n, err := claudeprep.ParseNodeSettings(jsjson.Marshal(c.ProviderSpecificData()))
	if err != nil {
		t.Fatal(err)
	}
	return n
}

func TestPlanDeclines(t *testing.T) {
	ctx := context.Background()
	cases := []struct {
		name, settings, model, want string
		extra                       map[string]any
		in                          func(*Incoming)
	}{
		{name: "a bare id that is no combo", settings: `{"requireApiKey":false}`, model: "m1", want: "bare model id"},
		{name: "an image", settings: `{"requireApiKey":false}`, model: "main", want: "capability",
			extra: map[string]any{"messages": []any{map[string]any{"role": "user", "content": []any{map[string]any{"type": "image", "source": map[string]any{"type": "base64", "media_type": "image/png", "data": "AAAA"}}}}}}},
		{name: "an API key required and none sent", settings: `{"requireApiKey":true}`, model: "main", want: "clientauth",
			in: func(in *Incoming) { in.PeerIP = "203.0.113.9" }},
		{name: "not a stream", settings: `{"requireApiKey":false}`, model: "main", want: "stream", extra: map[string]any{"stream": false}},
		{name: "a providerThinking mode that isn't a string", settings: `{"requireApiKey":false,"providerThinking":{"openai-compatible-chat-hot":{"mode":3}}}`, model: "main", want: "providerThinking"},
		{name: "the limit hold", settings: `{"requireApiKey":false,"limitHoldEnabled":true}`, model: "main", want: "limit hold"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			d := open(t, c.settings)
			n := New(d, clientip.NewRule(""), noEnv, "")
			in := ccIncoming()
			if c.in != nil {
				c.in(&in)
			}
			_, err := n.Plan(ctx, in, body(t, c.model, c.extra))
			if !decline.Is(err) || !strings.Contains(err.Error(), c.want) {
				t.Fatalf("want a decline naming %q, got %v", c.want, err)
			}
		})
	}
}

func TestModelHangFollowsTheHeadersBudget(t *testing.T) {
	d := open(t, `{"requireApiKey":false}`)
	env := func(k string) string {
		if k == "UPSTREAM_STREAM_HEADERS_TIMEOUT_MS" {
			return "4321"
		}
		return ""
	}
	n := New(d, clientip.NewRule(""), env, "")
	if got, want := n.Accounts.Hang.BudgetMs, upstream.HeadersBudget(env, true).Ms; got != want || got == New(d, nil, noEnv, "").Accounts.Hang.BudgetMs {
		t.Fatalf("BudgetMs %v, want %v (and not the default)", got, want)
	}
}

// The catalog is DATA_DIR/model-catalog.json, beside the database's db/
// directory, as catalogOverride.js and src/lib/db/paths.js put them.
func TestCatalogFileIsBesideTheDatabase(t *testing.T) {
	dir := t.TempDir()
	dataFile, err := db.DataFile(func(k string) string {
		if k == "DATA_DIR" {
			return dir
		}
		return ""
	})
	if err != nil {
		t.Fatal(err)
	}
	if got, want := CatalogFile(dataFile), filepath.Join(dir, "model-catalog.json"); got != want {
		t.Fatalf("CatalogFile(%s) = %s, want %s", dataFile, got, want)
	}
}

func TestReady(t *testing.T) {
	if err := Ready(); err != nil {
		t.Fatal(err)
	}
}

func TestClientHeadersFoldsRepeatsAsNode(t *testing.T) {
	h := http.Header{}
	h.Add("User-Agent", "first")
	h.Add("User-Agent", "second")
	h.Add("Accept", "a")
	h.Add("Accept", "b")
	h.Add("Cookie", "x=1")
	h.Add("Cookie", "y=2")
	h.Add("Anthropic-Beta", "f1")
	h.Add("anthropic-beta", "f2")
	got := ClientHeaders(h, "example.test")
	want := map[string]string{"user-agent": "first", "accept": "a, b", "cookie": "x=1; y=2", "anthropic-beta": "f1, f2", "host": "example.test"}
	for k, v := range want {
		if got[k] != v {
			t.Errorf("%s = %q, want %q", k, got[k], v)
		}
	}
}

func TestProviderThinking(t *testing.T) {
	cases := []struct {
		settings, want string
		declines       bool
	}{
		{settings: `{}`},
		{settings: `{"providerThinking":null}`},
		{settings: `{"providerThinking":{"p":{"mode":"high"}}}`, want: "high"},
		{settings: `{"providerThinking":{"p":{"mode":""}}}`},
		{settings: `{"providerThinking":{"p":null}}`},
		{settings: `{"providerThinking":{"other":{"mode":"high"}}}`},
		{settings: `{"providerThinking":"high"}`, declines: true},
		{settings: `{"providerThinking":{"p":"high"}}`, declines: true},
		{settings: `{"providerThinking":{"p":{"mode":true}}}`, declines: true},
	}
	for _, c := range cases {
		o, err := jsjson.ParseObject([]byte(c.settings))
		if err != nil {
			t.Fatal(err)
		}
		got, err := ProviderThinking(db.Settings{Merged: o}, "p")
		if c.declines != decline.Is(err) || got != c.want {
			t.Errorf("%s: %q, %v", c.settings, got, err)
		}
	}
}

func TestLearnedBetasGoToNodeAndWait(t *testing.T) {
	var got map[string]any
	var token string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(raw, &got)
		token = r.Header.Get(nodeevents.TokenHeader)
		if r.URL.Path != nodeevents.Path {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer srv.Close()
	n := &Native{Events: &nodeevents.Client{Base: srv.URL, Token: "peer-token", HTTP: srv.Client()}}
	n.LearnedBetas("openai-compatible-chat-hot", &db.Connection{ID: "k1"})([]string{"flag-a", "flag-b"})
	// LearnedBetas returns once Node answered, as Node awaits its write.
	if token != "peer-token" || got["type"] != "betas-learned" || got["connectionId"] != "k1" || got["provider"] != "openai-compatible-chat-hot" {
		t.Fatalf("token %q, event %v", token, got)
	}
	if flags, _ := got["droppedBetas"].([]any); len(flags) != 2 || flags[0] != "flag-a" {
		t.Fatalf("flags %v", got["droppedBetas"])
	}
}
