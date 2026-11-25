package upstream

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"slices"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/some-du6e/10router/gateway/internal/claudeprep"
	"github.com/some-du6e/10router/gateway/internal/db"
	"github.com/some-du6e/10router/gateway/internal/db/jsjson"
	"github.com/some-du6e/10router/gateway/internal/decline"
)

func readJSON(t *testing.T, path string, v any) {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(raw, v); err != nil {
		t.Fatal(err)
	}
}

func envOf(m map[string]string) Env { return func(k string) string { return m[k] } }

type vectorFile struct {
	Budgets []struct {
		Env    map[string]string `json:"env"`
		Stream bool              `json:"stream"`
		Ms     float64           `json:"ms"`
		SetBy  string            `json:"setBy"`
		Text   string            `json:"text"`
	} `json:"budgets"`
	Rejections []struct {
		Text  string   `json:"text"`
		Flags []string `json:"flags"`
	} `json:"rejections"`
	Proxies []struct {
		Input struct {
			Account  json.RawMessage `json:"account"`
			Provider any             `json:"provider"`
			Global   any             `json:"global"`
		} `json:"input"`
		Pools map[string]json.RawMessage `json:"pools"`
		Out   struct {
			Layer                  string `json:"layer"`
			ConnectionProxyEnabled bool   `json:"connectionProxyEnabled"`
			ConnectionProxyURL     string `json:"connectionProxyUrl"`
			ConnectionNoProxy      string `json:"connectionNoProxy"`
			StrictProxy            bool   `json:"strictProxy"`
			VercelRelayURL         string `json:"vercelRelayUrl"`
			Direct                 bool   `json:"direct"`
			Blocked                bool   `json:"blocked"`
		} `json:"out"`
		Transport string `json:"transport"`
	} `json:"proxies"`
	// FetchDefaults: the headers Node's own fetch put on a POST with the
	// executor's headers, per target, seen by a dispatcher that sends nothing.
	FetchDefaults []struct {
		URL     string      `json:"url"`
		Given   [][2]string `json:"given"`
		Headers [][2]string `json:"headers"`
	} `json:"fetchDefaults"`
	// EnvProxies: getEnvProxyUrl(target) under an environment.
	EnvProxies []struct {
		Env    map[string]string `json:"env"`
		Target string            `json:"target"`
		Proxy  *string           `json:"proxy"`
	} `json:"envProxies"`
}

type fakePools map[string]*db.ProxyPool

func (p fakePools) ProxyPoolByID(_ context.Context, id string) (*db.ProxyPool, error) {
	return p[id], nil
}

type objSettings struct{ o *jsjson.Object }

func (s objSettings) Get(key string) (any, bool) { return s.o.Get(key) }

func TestVectorsMatchNode(t *testing.T) {
	var v vectorFile
	readJSON(t, "testdata/vectors.json", &v)
	if len(v.Budgets) < 40 || len(v.Rejections) < 10 || len(v.Proxies) < 15 || len(v.FetchDefaults) < 2 || len(v.EnvProxies) < 10 {
		t.Fatal("too few vectors")
	}
	for _, c := range v.FetchDefaults {
		var h []claudeprep.HeaderField
		for _, kv := range c.Given {
			h = append(h, claudeprep.HeaderField{Name: kv[0], Value: kv[1]})
		}
		if g, n := sortedHeaders(WireHeaders(c.URL, h)), sortedHeaders(c.Headers); g != n {
			t.Errorf("fetch defaults for %s:\n go\n%s\n node\n%s", c.URL, g, n)
		}
	}
	for _, c := range v.EnvProxies {
		want := ""
		if c.Proxy != nil {
			want = jsTrim(*c.Proxy)
		}
		if got := envProxyURL(envOf(c.Env), c.Target); got != want {
			t.Errorf("getEnvProxyUrl(%s) with %v = %q, Node %q", c.Target, c.Env, got, want)
		}
	}
	for _, c := range v.Budgets {
		b := HeadersBudget(envOf(c.Env), c.Stream)
		if b.Ms != c.Ms || b.SetBy != c.SetBy || b.TimeoutText() != c.Text {
			t.Errorf("budget %v stream=%v: %+v %q, Node %v %q %q", c.Env, c.Stream, b, b.TimeoutText(), c.Ms, c.SetBy, c.Text)
		}
	}
	for _, c := range v.Rejections {
		if got := parseRejectedBetas(c.Text); !slices.Equal(got, c.Flags) {
			t.Errorf("parseRejectedBetas(%q) = %q, Node %q", c.Text, got, c.Flags)
		}
	}
	for i, c := range v.Proxies {
		pools := fakePools{}
		for id, raw := range c.Pools {
			o, err := jsjson.ParseObject(raw)
			if err != nil {
				t.Fatal(err)
			}
			active, _ := o.Get("isActive")
			pools[id] = &db.ProxyPool{ID: id, IsActive: active == true, Data: o}
		}
		psd := jsjson.NewObject()
		if len(c.Input.Account) > 0 {
			o, err := jsjson.ParseObject(c.Input.Account)
			if err != nil {
				t.Fatal(err)
			}
			psd = o
		}
		settings := jsjson.NewObject()
		if c.Input.Provider != nil {
			entry := jsjson.NewObject()
			entry.Set("proxyPoolId", c.Input.Provider)
			strategies := jsjson.NewObject()
			strategies.Set("p", entry)
			settings.Set("providerStrategies", strategies)
		}
		if c.Input.Global != nil {
			settings.Set("globalProxyPoolId", c.Input.Global)
		}
		r, err := ResolveRoute(context.Background(), psd, "p", objSettings{settings}, pools)
		if err != nil {
			t.Fatalf("case %d: %v", i, err)
		}
		o := c.Out
		if r.Layer != o.Layer || r.ConnectionProxyEnabled != o.ConnectionProxyEnabled || r.ConnectionProxyURL != o.ConnectionProxyURL ||
			r.ConnectionNoProxy != o.ConnectionNoProxy || r.StrictProxy != o.StrictProxy || r.VercelRelayURL != o.VercelRelayURL ||
			r.Direct != o.Direct || (r.BlockedReason != "") != o.Blocked || r.Transport() != c.Transport {
			t.Errorf("case %d %s: %+v %s, Node %+v %s", i, c.Input.Account, r, r.Transport(), o, c.Transport)
		}
	}
}

func TestOnlyDirectRoutesAreSent(t *testing.T) {
	target := "https://api.example.test/v1/messages"
	none := envOf(nil)
	cases := []struct {
		r    Resolved
		env  Env
		want string
	}{
		{Resolved{Layer: "system"}, none, ""},
		{Resolved{Layer: "account", Direct: true}, envOf(map[string]string{"HTTPS_PROXY": "http://proxy.example.test"}), ""},
		{Resolved{Layer: "system"}, envOf(map[string]string{"HTTPS_PROXY": "http://proxy.example.test"}), "system proxy"},
		{Resolved{Layer: "system"}, envOf(map[string]string{"https_proxy": "http://proxy.example.test"}), "system proxy"},
		{Resolved{Layer: "system"}, envOf(map[string]string{"ALL_PROXY": "socks5://proxy.example.test"}), "system proxy"},
		{Resolved{Layer: "system"}, envOf(map[string]string{"HTTP_PROXY": "http://proxy.example.test"}), ""},
		{Resolved{Layer: "system"}, envOf(map[string]string{"HTTPS_PROXY": "   ", "https_proxy": "http://proxy.example.test"}), ""},
		{Resolved{Layer: "system"}, envOf(map[string]string{"HTTPS_PROXY": "http://p.test", "NO_PROXY": "example.test"}), ""},
		{Resolved{Layer: "system"}, envOf(map[string]string{"HTTPS_PROXY": "http://p.test", "NO_PROXY": ".api.example.test"}), ""},
		{Resolved{Layer: "system"}, envOf(map[string]string{"HTTPS_PROXY": "http://p.test", "no_proxy": "*"}), ""},
		{Resolved{Layer: "system"}, envOf(map[string]string{"HTTPS_PROXY": "http://p.test", "NO_PROXY": "other.test, xample.test"}), "system proxy"},
		{Resolved{Layer: "account", ConnectionProxyEnabled: true, ConnectionProxyURL: "http://p.test"}, none, "proxy pool"},
		{Resolved{Layer: "global", VercelRelayURL: "https://relay.test"}, none, "relay"},
		{Resolved{Layer: "global", BlockedReason: "gone"}, none, "refuses"},
	}
	for i, c := range cases {
		err := c.r.Sendable(c.env, target)
		switch {
		case c.want == "" && err != nil:
			t.Errorf("case %d: %v", i, err)
		case c.want != "" && (!decline.Is(err) || !strings.Contains(err.Error(), c.want)):
			t.Errorf("case %d: want a decline naming %q, got %v", i, c.want, err)
		}
	}
}

func TestWireHeadersJoinRepeatsAndAddFetchDefaults(t *testing.T) {
	h := []claudeprep.HeaderField{{Name: "anthropic-beta", Value: "a"}, {Name: "Anthropic-Beta", Value: "b"}, {Name: "Accept", Value: "text/event-stream"}, {Name: "User-Agent", Value: "x/1"}}
	got := WireHeaders("http://upstream.test/v1", h)
	want := [][2]string{{"anthropic-beta", "a, b"}, {"accept", "text/event-stream"}, {"user-agent", "x/1"}, {"accept-language", "*"}, {"sec-fetch-mode", "cors"}, {"accept-encoding", "gzip, deflate"}, {"connection", "keep-alive"}}
	if !slices.Equal(got, want) {
		t.Fatalf("got %v", got)
	}
	if got := WireHeaders("https://upstream.test/v1", h); got[5] != [2]string{"accept-encoding", "br, gzip, deflate"} {
		t.Fatalf("https: %v", got)
	}
}

// ── Wire ─────────────────────────────────────────────────────────────────────

type wireFile []struct {
	Name          string            `json:"name"`
	Env           map[string]string `json:"env"`
	Script        []json.RawMessage `json:"script"`
	Provider      string            `json:"provider"`
	ClientHeaders map[string]string `json:"clientHeaders"`
	ClientBody    string            `json:"clientBody"`
	PSD           json.RawMessage   `json:"psd"`
	Requests      []wireRequest     `json:"requests"`
	Events        []struct {
		Budget  float64 `json:"budget"`
		Sleep   float64 `json:"sleep"`
		Attempt *struct {
			Success        bool   `json:"success"`
			Status         int    `json:"status"`
			Error          string `json:"error"`
			HeadersTimeout *struct {
				Stream bool `json:"stream"`
			} `json:"headersTimeout"`
		} `json:"attempt"`
	} `json:"events"`
	SavedBetas struct {
		Connection []string `json:"connection"`
	} `json:"savedBetas"`
}

type wireRequest struct {
	Method  string      `json:"method"`
	Path    string      `json:"path"`
	Headers [][2]string `json:"headers"`
	Body    string      `json:"body"`
}

type scriptStep struct {
	Status   int    `json:"status"`
	Body     string `json:"body"`
	RawBytes []int  `json:"bodyBytes"`
	Gzip     bool   `json:"gzip"`
	// Cut: promise more than is sent, then drop the connection.
	Cut bool `json:"cut"`
	// NoTrailer: the gzip body without its 8-byte trailer.
	NoTrailer bool `json:"noTrailer"`
}

const sseOK = "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n"

// scripted is the recorder's server: each request answered by the next step.
func scripted(t *testing.T, script []json.RawMessage) (*httptest.Server, *[]wireRequest) {
	t.Helper()
	var mu sync.Mutex
	var seen []wireRequest
	n := 0
	stop := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		var headers [][2]string
		for name, values := range r.Header {
			for _, v := range values {
				headers = append(headers, [2]string{strings.ToLower(name), v})
			}
		}
		mu.Lock()
		seen = append(seen, wireRequest{Method: r.Method, Path: r.URL.RequestURI(), Headers: headers, Body: string(body)})
		raw := script[min(n, len(script)-1)]
		n++
		mu.Unlock()
		var word string
		if json.Unmarshal(raw, &word) == nil {
			switch word {
			case "hang":
				select {
				case <-r.Context().Done():
				case <-stop:
				}
				return
			case "ok":
				w.Header().Set("content-type", "text/event-stream")
				_, _ = io.WriteString(w, sseOK)
				return
			}
		}
		var step scriptStep
		if err := json.Unmarshal(raw, &step); err != nil {
			t.Error(err)
			return
		}
		out := []byte(step.Body)
		if step.RawBytes != nil {
			out = make([]byte, len(step.RawBytes))
			for i, b := range step.RawBytes {
				out[i] = byte(b)
			}
		}
		w.Header().Set("content-type", "application/json")
		if step.Cut {
			conn, buf, err := w.(http.Hijacker).Hijack()
			if err != nil {
				t.Error(err)
				return
			}
			fmt.Fprintf(buf, "HTTP/1.1 %d X\r\nContent-Type: application/json\r\nContent-Length: %d\r\n\r\n%s", step.Status, len(out)+100, out)
			_ = buf.Flush()
			_ = conn.Close()
			return
		}
		if step.Gzip {
			var buf bytes.Buffer
			zw := gzip.NewWriter(&buf)
			_, _ = zw.Write(out)
			_ = zw.Close()
			out = buf.Bytes()
			w.Header().Set("content-encoding", "gzip")
		}
		if step.NoTrailer {
			out = out[:len(out)-8]
		}
		w.WriteHeader(step.Status)
		_, _ = w.Write(out)
	}))
	t.Cleanup(func() { close(stop); srv.Close() })
	return srv, &seen
}

func sortedHeaders(h [][2]string) string {
	out := make([]string, len(h))
	for i, kv := range h {
		out[i] = kv[0] + ": " + kv[1]
	}
	sort.Strings(out)
	return strings.Join(out, "\n")
}

func TestWireMatchesNode(t *testing.T) {
	var file wireFile
	readJSON(t, "testdata/wire.json", &file)
	if len(file) < 15 {
		t.Fatalf("only %d scenarios", len(file))
	}
	for _, sc := range file {
		t.Run(sc.Name, func(t *testing.T) {
			srv, seen := scripted(t, sc.Script)
			psdJSON := strings.ReplaceAll(string(sc.PSD), "<base>", srv.URL+"/v1")
			node, err := claudeprep.ParseNodeSettings([]byte(psdJSON))
			if err != nil {
				t.Fatal(err)
			}
			var events []string
			var learned []string
			prepare := func(n claudeprep.NodeSettings) (*claudeprep.Request, error) {
				return claudeprep.Prepare([]byte(sc.ClientBody), claudeprep.Inputs{
					Provider: sc.Provider, Model: "m1", ClientHeaders: sc.ClientHeaders,
					Connection: claudeprep.Connection{APIKey: "key-k1", Node: n},
				})
			}
			s := NewSender()
			res, err := s.Execute(context.Background(), Input{
				Node: node, Prepare: prepare, Env: envOf(sc.Env),
				Sleep: func(_ context.Context, ms float64) error {
					events = append(events, fmt.Sprintf("sleep %v", ms))
					return nil
				},
				OnHeadersBudget: func(ms float64) { events = append(events, fmt.Sprintf("budget %v", ms)) },
				LearnedBetas:    func(flags []string) { learned = flags },
			})
			if err != nil {
				t.Fatal(err)
			}
			if res.Response != nil {
				_, _ = io.ReadAll(res.Response.Body)
				res.Response.Body.Close()
			}
			var want []string
			for _, e := range sc.Events {
				switch {
				case e.Attempt != nil:
					a := e.Attempt
					if a.Success != (res.Response != nil) || (!a.Success && (a.Status != res.Status || a.Error != res.Error)) || (a.HeadersTimeout != nil) != res.HeadersTimeout {
						t.Errorf("result: go %d %q timeout=%v ok=%v, Node %+v", res.Status, res.Error, res.HeadersTimeout, res.Response != nil, *a)
					}
				case e.Sleep > 0:
					want = append(want, fmt.Sprintf("sleep %v", e.Sleep))
				default:
					want = append(want, fmt.Sprintf("budget %v", e.Budget))
				}
			}
			if fmt.Sprint(events) != fmt.Sprint(want) {
				t.Errorf("events: go %v, Node %v", events, want)
			}
			if len(*seen) != len(sc.Requests) {
				t.Fatalf("go sent %d requests, Node %d", len(*seen), len(sc.Requests))
			}
			for i, got := range *seen {
				w := sc.Requests[i]
				if got.Method != w.Method || got.Path != w.Path || got.Body != w.Body {
					t.Errorf("request %d: go %s %s %s\n node %s %s %s", i, got.Method, got.Path, got.Body, w.Method, w.Path, w.Body)
				}
				if g, n := sortedHeaders(got.Headers), sortedHeaders(w.Headers); g != n {
					t.Errorf("request %d headers:\n go\n%s\n node\n%s", i, g, n)
				}
			}
			saved := sc.SavedBetas.Connection
			if !slices.Equal(learned, saved) {
				t.Errorf("learned %v, Node saved %v", learned, saved)
			}
		})
	}
}

// The gzip header is the body's first bytes: a stream whose first event
// comes after the headers budget is still the stream fetch would read.
func TestGzipStreamReadsPastTheHeadersBudget(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Encoding", "gzip")
		w.WriteHeader(200)
		w.(http.Flusher).Flush()
		time.Sleep(400 * time.Millisecond)
		zw := gzip.NewWriter(w)
		_, _ = io.WriteString(zw, sseOK)
		_ = zw.Close()
	}))
	defer srv.Close()
	s := NewSender()
	req := &claudeprep.Request{URL: srv.URL + "/v1/messages", Body: []byte("{}"), Stream: true}
	res, err := s.Execute(context.Background(), Input{
		Prepare: func(claudeprep.NodeSettings) (*claudeprep.Request, error) { return req, nil },
		Env:     envOf(map[string]string{"UPSTREAM_STREAM_HEADERS_TIMEOUT_MS": "150"}),
		Sleep:   func(context.Context, float64) error { return nil },
	})
	if err != nil || res.Response == nil {
		t.Fatalf("%+v %v", res, err)
	}
	defer res.Response.Body.Close()
	body, err := io.ReadAll(res.Response.Body)
	if err != nil || string(body) != sseOK {
		t.Fatalf("%q %v", body, err)
	}
}

func TestPreflightDeclinesWhatTheSenderWould(t *testing.T) {
	ctx := context.Background()
	conn := func(psd string) *db.Connection {
		o, err := jsjson.ParseObject([]byte(psd))
		if err != nil {
			t.Fatal(err)
		}
		data := jsjson.NewObject()
		data.Set("providerSpecificData", o)
		return &db.Connection{ID: "k1", Provider: "openai-compatible-chat-x", IsActive: true, Data: data}
	}
	plain := `{"apiType":"chat","baseUrl":"https://upstream.test/v1","modelRoutes":{"m":"anthropic"}}`
	settings := func(kv ...any) Settings {
		o := jsjson.NewObject()
		for i := 0; i < len(kv); i += 2 {
			o.Set(kv[i].(string), kv[i+1])
		}
		return objSettings{o}
	}
	pools := fakePools{"p": {ID: "p", IsActive: true, Data: func() *jsjson.Object {
		o, _ := jsjson.ParseObject([]byte(`{"proxyUrl":"http://proxy.test:1"}`))
		return o
	}()}}
	cases := []struct {
		name, psd, want string
		s               Settings
		env             map[string]string
	}{
		{name: "plain", psd: plain},
		{name: "outbound proxy setting", psd: plain, s: settings("outboundProxyEnabled", true), want: "outbound proxy"},
		{name: "endpoint timeout", psd: `{"apiType":"chat","baseUrl":"https://upstream.test/v1","overrides":{"timeout":"30"}}`, want: "Timeout"},
		{name: "proxy pool", psd: `{"apiType":"chat","baseUrl":"https://upstream.test/v1","proxyPoolId":"p"}`, want: "proxy pool"},
		{name: "global pool", psd: plain, s: settings("globalProxyPoolId", "p"), want: "proxy pool"},
		{name: "extra CA", psd: plain, env: map[string]string{"NODE_EXTRA_CA_CERTS": "/certs/x.pem"}, want: "NODE_EXTRA_CA_CERTS"},
		{name: "system proxy", psd: plain, env: map[string]string{"HTTPS_PROXY": "http://proxy.test:2"}, want: "system proxy"},
		{name: "IPv6 host", psd: `{"apiType":"chat","baseUrl":"https://[::1]:8443/v1"}`, want: "WHATWG"},
	}
	for _, c := range cases {
		s := c.s
		if s == nil {
			s = settings()
		}
		err := Preflight(ctx, conn(c.psd), s, pools, envOf(c.env))
		switch {
		case c.want == "" && err != nil:
			t.Errorf("%s: %v", c.name, err)
		case c.want != "" && (err == nil || !strings.Contains(err.Error(), c.want)):
			t.Errorf("%s: want a decline naming %q, got %v", c.name, c.want, err)
		}
	}
}

func TestIdleBodyFailsASilentRead(t *testing.T) {
	r, w := io.Pipe()
	defer w.Close()
	body := newIdleBody(r, 50*time.Millisecond)
	go func() { _, _ = w.Write([]byte("a")) }()
	buf := make([]byte, 4)
	if n, err := body.Read(buf); n != 1 || err != nil {
		t.Fatalf("first read: %d %v", n, err)
	}
	if _, err := body.Read(buf); err == nil {
		t.Fatal("a body silent past the idle limit must fail its read")
	}
}

func TestErrorsDontQuoteTheURL(t *testing.T) {
	s := NewSender()
	// A closed port: the connect fails at once.
	srv := httptest.NewServer(http.NotFoundHandler())
	target := srv.URL + "/v1/messages?key=secret-in-query"
	srv.Close()
	_, err := s.Send(context.Background(), &claudeprep.Request{URL: target, Body: []byte("{}")})
	if err == nil || strings.Contains(err.Error(), "secret-in-query") || !strings.Contains(err.Error(), "network") {
		t.Fatalf("%v", err)
	}
}

func TestStatusesNodeCantReplyWithGoToNode(t *testing.T) {
	s := NewSender()
	for _, status := range []int{204, 205, 304, 999} {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(status) }))
		_, err := s.Send(context.Background(), &claudeprep.Request{URL: srv.URL, Body: []byte("{}")})
		srv.Close()
		if err == nil || !strings.Contains(err.Error(), "network") {
			t.Fatalf("status %d: %v", status, err)
		}
	}
}

func TestMergeDroppedBetas(t *testing.T) {
	n := MergeDroppedBetas(claudeprep.NodeSettings{DroppedBetas: []string{"a-1"}}, []string{"a-1", " b-2 ", "foo/bar", strings.Repeat("x", 82), "-lead"})
	if !slices.Equal(n.DroppedBetas, []string{"a-1", "b-2"}) {
		t.Fatalf("sanitizeNodeQuirks keeps flag names only: %v", n.DroppedBetas)
	}
	if m := MergeDroppedBetas(n, nil); !slices.Equal(m.DroppedBetas, n.DroppedBetas) {
		t.Fatal("nothing learned changes nothing")
	}
	var many []string
	for i := 0; i < 60; i++ {
		many = append(many, fmt.Sprintf("f-%d", i))
	}
	if got := MergeDroppedBetas(claudeprep.NodeSettings{}, many); len(got.DroppedBetas) != 50 {
		t.Fatalf("at most 50: %d", len(got.DroppedBetas))
	}
}

func TestExecuteReturnsAFailedRetryWait(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(503) }))
	defer srv.Close()
	sleepErr := errors.New("sleep failed")
	req := &claudeprep.Request{URL: srv.URL, Body: []byte("{}")}
	_, err := NewSender().Execute(context.Background(), Input{
		Prepare: func(claudeprep.NodeSettings) (*claudeprep.Request, error) { return req, nil },
		Env:     envOf(nil),
		Sleep:   func(context.Context, float64) error { return sleepErr },
	})
	if !errors.Is(err, sleepErr) {
		t.Fatalf("%v", err)
	}
}

func TestNonASCIINoProxyIsNodesCall(t *testing.T) {
	r := Resolved{Layer: "system"}
	env := envOf(map[string]string{"HTTPS_PROXY": "http://proxy.test:1", "NO_PROXY": "İnternal.test"})
	if err := r.Sendable(env, "https://internal.test/v1"); !decline.Is(err) {
		t.Fatalf("%v", err)
	}
	if err := r.Sendable(envOf(map[string]string{"NO_PROXY": "İnternal.test"}), "https://internal.test/v1"); err != nil {
		t.Fatalf("no proxy set, NO_PROXY can't matter: %v", err)
	}
}

func TestPrepareTwiceIsByteEqual(t *testing.T) {
	var file wireFile
	readJSON(t, "testdata/wire.json", &file)
	sc := file[0]
	node, err := claudeprep.ParseNodeSettings([]byte(strings.ReplaceAll(string(sc.PSD), "<base>", "https://api.example.test/v1")))
	if err != nil {
		t.Fatal(err)
	}
	in := claudeprep.Inputs{Provider: sc.Provider, Model: "m1", ClientHeaders: sc.ClientHeaders, Connection: claudeprep.Connection{APIKey: "key-k1", Node: node}}
	a, err := claudeprep.Prepare([]byte(sc.ClientBody), in)
	if err != nil {
		t.Fatal(err)
	}
	b, err := claudeprep.Prepare([]byte(sc.ClientBody), in)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(a.Body, b.Body) || fmt.Sprint(a.Header) != fmt.Sprint(b.Header) || a.URL != b.URL {
		t.Fatal("a resend would not be the bytes Node reuses")
	}
}

func TestOverridesAndRedirectsGoToNode(t *testing.T) {
	ctx := context.Background()
	s := NewSender()
	_, err := s.Execute(ctx, Input{Node: claudeprep.NodeSettings{Overrides: &claudeprep.Overrides{Timeout: "30"}}, Prepare: nil})
	if !decline.Is(err) {
		t.Fatalf("an endpoint Timeout is Node's: %v", err)
	}
	for _, status := range []int{301, 302, 303, 307, 308, 421} {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Location", "/elsewhere")
			w.WriteHeader(status)
		}))
		_, err := s.Send(ctx, &claudeprep.Request{URL: srv.URL + "/v1/messages", Body: []byte("{}")})
		srv.Close()
		if err == nil || !strings.Contains(err.Error(), "network") {
			t.Fatalf("status %d: %v", status, err)
		}
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Encoding", "br")
		w.WriteHeader(500)
	}))
	defer srv.Close()
	if _, err := s.Send(ctx, &claudeprep.Request{URL: srv.URL, Body: []byte("{}")}); err == nil {
		t.Fatal("a br body goes to Node")
	}
}
