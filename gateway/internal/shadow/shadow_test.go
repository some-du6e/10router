package shadow

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/some-du6e/10router/gateway/internal/claudeprep"
	"github.com/some-du6e/10router/gateway/internal/clientip"
	"github.com/some-du6e/10router/gateway/internal/db"
	"github.com/some-du6e/10router/gateway/internal/db/dbtest"
	"github.com/some-du6e/10router/gateway/internal/db/jsjson"
	"github.com/some-du6e/10router/gateway/internal/native"
)

func conn(id, provider string) map[string]any {
	return map[string]any{
		"id": id, "provider": provider, "authType": "apikey", "name": id, "priority": 1, "isActive": 1,
		"data":      `{"apiKey":"key-` + id + `","providerSpecificData":{"apiType":"chat","baseUrl":"https://gateway.example.test/v1","modelRoutes":{"m1":"anthropic","m2":"anthropic"}}}`,
		"createdAt": "2026-03-01T11:00:00.000Z", "updatedAt": "2026-03-01T11:00:00.000Z",
	}
}

func route(t *testing.T) *native.Native {
	t.Helper()
	path, raw := dbtest.New(t, dbtest.Options{})
	dbtest.InsertRows(t, raw, map[string][]map[string]any{
		"providerNodes": {{
			"id": "openai-compatible-chat-hot", "type": "openai-compatible", "name": "hot",
			"data":      `{"prefix":"hot","apiType":"chat","baseUrl":"https://gateway.example.test/v1"}`,
			"createdAt": "2026-03-01T10:00:00.000Z", "updatedAt": "2026-03-01T10:00:00.000Z",
		}},
		"combos": {
			{"id": "combo-main", "name": "main", "models": `["hot/m1"]`, "createdAt": "2026-03-01T10:00:00.000Z", "updatedAt": "2026-03-01T10:00:00.000Z"},
			{"id": "combo-pair", "name": "pair", "models": `["hot/m1","hot/m2"]`, "createdAt": "2026-03-01T10:00:00.000Z", "updatedAt": "2026-03-01T10:00:00.000Z"},
		},
		"providerConnections": {conn("k1", "openai-compatible-chat-hot"), conn("k2", "openai-compatible-chat-hot")},
	})
	dbtest.Exec(t, raw, `INSERT INTO settings(id, data) VALUES(1, ?)`, `{"requireApiKey":false}`)
	d, err := db.Open(path, db.Options{})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(func() { cancel(); d.Close() })
	if err := d.Watch(ctx, db.WatchOptions{}); err != nil {
		t.Fatal(err)
	}
	return native.New(d, clientip.NewRule(""), func(string) string { return "" }, "")
}

func ccRequest(t *testing.T, model string) *http.Request {
	t.Helper()
	raw, _ := json.Marshal(map[string]any{
		"model": model, "max_tokens": 1024, "stream": true,
		"messages": []any{map[string]any{"role": "user", "content": "Explain the build failure in step three."}},
	})
	r := httptest.NewRequest(http.MethodPost, "http://localhost:20128/v1/messages", bytes.NewReader(raw))
	r.RemoteAddr = "127.0.0.1:50000"
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("User-Agent", "claude-cli/2.1.258 (external, cli)")
	r.Header.Set("X-App", "cli")
	r.Header.Set("Anthropic-Version", "2023-06-01")
	r.Header.Set(IDHeader, "client-sent")
	return r
}

// asNode is the report Node would make for Go's own request.
func asNode(id string, req *claudeprep.Request) Report {
	rep := Report{ID: id, URL: req.URL, Method: http.MethodPost, HeadersKind: "object", BodyKind: "string", Body: req.Body}
	for _, f := range req.Header {
		rep.Headers = append(rep.Headers, [2]string{f.Name, f.Value})
	}
	return rep
}

func prepared(t *testing.T, n *native.Native, r *http.Request, raw []byte, key string) *claudeprep.Request {
	t.Helper()
	return preparedLeaf(t, n, r, raw, key, 0)
}

func preparedLeaf(t *testing.T, n *native.Native, r *http.Request, raw []byte, key string, leaf int) *claudeprep.Request {
	t.Helper()
	p, err := n.Plan(context.Background(), native.Incoming{Header: r.Header, Host: r.Host, PeerIP: "127.0.0.1"}, raw)
	if err != nil {
		t.Fatal(err)
	}
	c, err := n.DB.ConnectionByID(context.Background(), key)
	if err != nil {
		t.Fatal(err)
	}
	prepare, err := n.Prepare(p, p.Leaves[leaf], c)
	if err != nil {
		t.Fatal(err)
	}
	node, err := claudeprep.ParseNodeSettings(jsjson.Marshal(c.ProviderSpecificData()))
	if err != nil {
		t.Fatal(err)
	}
	req, err := prepare(node)
	if err != nil {
		t.Fatal(err)
	}
	return req
}

func TestObserveThenCompare(t *testing.T) {
	n := route(t)
	s := &Shadow{Native: func() (*native.Native, string) { return n, "" }, Token: "t", Grace: 10 * time.Millisecond}
	r := ccRequest(t, "main")
	out, finish := s.Observe(r, "127.0.0.1")
	id := out.Header.Get(IDHeader)
	if id == "" || id == "client-sent" || len(id) != 32 {
		t.Fatalf("shadow id %q", id)
	}
	raw, _ := io.ReadAll(out.Body)
	if !strings.Contains(string(raw), `"model":"main"`) {
		t.Fatalf("the relayed body changed: %s", raw)
	}
	req := prepared(t, n, ccRequest(t, "main"), raw, "k2")

	ctx := context.Background()
	s.Compare(ctx, asNode(id, req))
	if st := s.Snapshot(); st.Planned != 1 || st.Matched != 1 || st.Differed != 0 {
		t.Fatalf("after a matching send: %+v", st)
	}

	other := asNode(id, req)
	other.Body = bytes.Replace(other.Body, []byte("three"), []byte("four"), 1)
	s.Compare(ctx, other)
	st := s.Snapshot()
	if st.Differed != 1 || len(st.Diffs) != 1 || !strings.Contains(st.Diffs[0], "body") {
		t.Fatalf("after a different body: %+v", st)
	}

	stranger := asNode(id, req)
	for i := range stranger.Headers {
		stranger.Headers[i][1] = strings.ReplaceAll(stranger.Headers[i][1], "key-k2", "key-elsewhere")
	}
	s.Compare(ctx, stranger)
	if st := s.Snapshot(); st.Differed != 2 || !strings.Contains(st.Diffs[1], "none of the plan's keys") {
		t.Fatalf("after a send with another credential: %+v", st)
	}

	s.Compare(ctx, Report{ID: "nobody"})
	finish()
	deadline := time.Now().Add(5 * time.Second)
	for {
		s.mu.Lock()
		left := len(s.pending)
		s.mu.Unlock()
		if left == 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the request was never scored")
		}
		time.Sleep(5 * time.Millisecond)
	}
	if st := s.Snapshot(); st.Unknown != 1 || st.NoSend != 0 || st.Sends != 4 {
		t.Fatalf("at the end: %+v", st)
	}
}

// A request's first send matching a later combo member is a match, and
// counted Reordered: Node tried another member first. A Buffer body ("bytes")
// compares the same as a string one.
func TestFirstSendForALaterMemberIsReordered(t *testing.T) {
	n := route(t)
	s := &Shadow{Native: func() (*native.Native, string) { return n, "" }, Token: "t", Grace: time.Hour}
	out, _ := s.Observe(ccRequest(t, "pair"), "127.0.0.1")
	id := out.Header.Get(IDHeader)
	raw, _ := io.ReadAll(out.Body)
	second := asNode(id, preparedLeaf(t, n, ccRequest(t, "pair"), raw, "k1", 1))
	second.BodyKind = "bytes"
	s.Compare(context.Background(), second)
	first := asNode(id, preparedLeaf(t, n, ccRequest(t, "pair"), raw, "k1", 0))
	s.Compare(context.Background(), first)
	st := s.Snapshot()
	if st.Matched != 2 || st.Reordered != 1 || st.Differed != 0 || len(st.Diffs) != 1 || !strings.Contains(st.Diffs[0], "m2") {
		t.Fatalf("%+v", st)
	}
	// Another request whose first send is the first member's isn't.
	out, _ = s.Observe(ccRequest(t, "pair"), "127.0.0.1")
	first.ID = out.Header.Get(IDHeader)
	s.Compare(context.Background(), first)
	if st := s.Snapshot(); st.Reordered != 1 || st.Matched != 3 {
		t.Fatalf("%+v", st)
	}
}

func TestPlannedWithoutASendIsNoSend(t *testing.T) {
	n := route(t)
	s := &Shadow{Native: func() (*native.Native, string) { return n, "" }, Token: "t", Grace: time.Millisecond}
	_, finish := s.Observe(ccRequest(t, "main"), "127.0.0.1")
	finish()
	deadline := time.Now().Add(5 * time.Second)
	for s.Snapshot().NoSend == 0 {
		if time.Now().After(deadline) {
			t.Fatal("no NoSend")
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func TestDeclinedRequestsAreCountedAndTheirSendsUnplanned(t *testing.T) {
	n := route(t)
	s := &Shadow{Native: func() (*native.Native, string) { return n, "" }, Token: "t", Grace: time.Hour}
	out, _ := s.Observe(ccRequest(t, "m1"), "127.0.0.1")
	s.Compare(context.Background(), Report{ID: out.Header.Get(IDHeader), Method: "POST"})
	st := s.Snapshot()
	if st.Declined != 1 || st.Unplanned != 1 || st.Planned != 0 {
		t.Fatalf("%+v", st)
	}
	found := false
	for reason := range st.Reasons {
		found = found || strings.Contains(reason, "bare model id")
	}
	if !found {
		t.Fatalf("reasons %v", st.Reasons)
	}
}

func TestObserveWithTheRouteOff(t *testing.T) {
	s := &Shadow{Native: func() (*native.Native, string) { return nil, "the database has not been opened yet" }}
	r := ccRequest(t, "main")
	out, finish := s.Observe(r, "127.0.0.1")
	finish()
	if out.Header.Get(IDHeader) != "" {
		t.Fatal("a client's shadow id reached Node")
	}
	if st := s.Snapshot(); st.Declined != 1 || st.Reasons["native route off: the database has not been opened yet"] != 1 {
		t.Fatalf("%+v", st)
	}
}

// A panic in the shadow's planning is its own error: the request is relayed
// with its body, untagged.
func TestPlanningPanicStillRelays(t *testing.T) {
	// No database: Plan's first read panics.
	s := &Shadow{Native: func() (*native.Native, string) { return &native.Native{}, "" }}
	want, _ := io.ReadAll(ccRequest(t, "main").Body)
	out, finish := s.Observe(ccRequest(t, "main"), "127.0.0.1")
	finish()
	got, _ := io.ReadAll(out.Body)
	st := s.Snapshot()
	if !bytes.Equal(got, want) || st.Errors != 1 || st.Planned != 0 || st.Declined != 1 {
		t.Fatalf("relayed %d bytes, stats %+v", len(got), st)
	}
}

func TestOversizedBodyIsRelayedWhole(t *testing.T) {
	s := &Shadow{Native: func() (*native.Native, string) { return &native.Native{}, "" }, MaxBody: 8}
	r := ccRequest(t, "main")
	want, _ := io.ReadAll(ccRequest(t, "main").Body)
	out, _ := s.Observe(r, "127.0.0.1")
	got, _ := io.ReadAll(out.Body)
	if !bytes.Equal(got, want) || out.Header.Get(IDHeader) != "" {
		t.Fatalf("relayed %q", got)
	}
}

func TestServeReportTakesOnlyNodesReports(t *testing.T) {
	s := &Shadow{Native: func() (*native.Native, string) { return nil, "off" }, Token: "the-peer-token"}
	post := func(remote, token, body string) int {
		r := httptest.NewRequest(http.MethodPost, ReportPath, strings.NewReader(body))
		r.RemoteAddr = remote
		if token != "" {
			r.Header.Set(TokenHeader, token)
		}
		w := httptest.NewRecorder()
		s.ServeReport(w, r)
		return w.Code
	}
	ok := `{"id":"x","url":"https://gateway.example.test/v1/messages","method":"POST","headersKind":"object","headers":[["a","b"]],"bodyKind":"string","body":"e30="}`
	if c := post("203.0.113.9:1", "the-peer-token", ok); c != http.StatusForbidden {
		t.Fatalf("remote peer: %d", c)
	}
	if c := post("127.0.0.1:1", "", ok); c != http.StatusForbidden {
		t.Fatalf("no token: %d", c)
	}
	if c := post("127.0.0.1:1", "the-peer-token-", ok); c != http.StatusForbidden {
		t.Fatalf("wrong token: %d", c)
	}
	if c := post("127.0.0.1:1", "the-peer-token", "{"); c != http.StatusBadRequest {
		t.Fatalf("bad JSON: %d", c)
	}
	if c := post("[::1]:1", "the-peer-token", ok); c != http.StatusNoContent {
		t.Fatalf("Node's report: %d", c)
	}
	r := httptest.NewRequest(http.MethodGet, ReportPath, nil)
	r.RemoteAddr = "127.0.0.1:1"
	w := httptest.NewRecorder()
	s.ServeReport(w, r)
	if w.Code != http.StatusMethodNotAllowed {
		t.Fatalf("GET: %d", w.Code)
	}
	if st := s.Snapshot(); st.Sends != 1 || st.Unknown != 1 || st.Errors != 1 {
		t.Fatalf("%+v", st)
	}
}

func TestDiffNeverQuotesCredentials(t *testing.T) {
	req := &claudeprep.Request{URL: "https://gateway.example.test/v1/messages", Header: []claudeprep.HeaderField{{Name: "x-api-key", Value: "key-secret-1"}, {Name: "x-custom", Value: "key-secret-1 again"}}}
	rep := Report{URL: req.URL, Headers: [][2]string{{"x-api-key", "key-secret-2"}}}
	c := &db.Connection{ID: "k", Data: jsjson.NewObject()}
	c.Data.Set("apiKey", "key-secret-1")
	for _, d := range []string{Diff(req, rep, c), Diff(&claudeprep.Request{URL: req.URL, Header: req.Header[1:]}, Report{URL: req.URL, Headers: [][2]string{{"x-custom", "other"}}}, c)} {
		if strings.Contains(d, "secret") || d == "" {
			t.Fatalf("diff %q", d)
		}
	}
	// The preparation's own non-secret headers are quoted; an endpoint's
	// header lines, under any name, are not.
	beta := Diff(&claudeprep.Request{URL: req.URL, Header: []claudeprep.HeaderField{{Name: "anthropic-beta", Value: "flag-a"}}}, Report{URL: req.URL, Headers: [][2]string{{"anthropic-beta", "flag-b"}}}, c)
	if !strings.Contains(beta, `"flag-a"`) || !strings.Contains(beta, `"flag-b"`) {
		t.Fatalf("beta diff %q", beta)
	}
	custom := Diff(&claudeprep.Request{URL: req.URL, Header: []claudeprep.HeaderField{{Name: "x-portal-key", Value: "pk-one"}}}, Report{URL: req.URL, Headers: [][2]string{{"x-portal-key", "pk-two"}}}, c)
	if strings.Contains(custom, "pk-") {
		t.Fatalf("custom header diff %q", custom)
	}
	if d := Diff(&claudeprep.Request{URL: "https://gateway.example.test/v1/messages?key=abc"}, Report{URL: "https://gateway.example.test/v1/messages?key=abd"}, nil); strings.Contains(d, "abc") || !strings.Contains(d, "URL") {
		t.Fatalf("URL diff %q", d)
	}
}
