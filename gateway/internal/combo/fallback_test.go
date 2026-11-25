package combo

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/some-du6e/10router/gateway/internal/accounts"
	"github.com/some-du6e/10router/gateway/internal/claudeprep"
	"github.com/some-du6e/10router/gateway/internal/db"
	"github.com/some-du6e/10router/gateway/internal/db/dbtest"
	"github.com/some-du6e/10router/gateway/internal/db/jsjson"
	"github.com/some-du6e/10router/gateway/internal/decline"
	"github.com/some-du6e/10router/gateway/internal/upstream"
)

// fallbackFile is testdata/fallback.json, recorded from Node's handleChat by
// tests/unit/gateway-combo-fallback-parity.test.js.
type fallbackFile []struct {
	Name string `json:"name"`
	// GoHandoff: Go hands the last request to Node with a reason naming it.
	GoHandoff string                      `json:"goHandoff"`
	Settings  *string                     `json:"settings"`
	Initial   map[string][]map[string]any `json:"initial"`
	Requests  []struct {
		Model     string  `json:"model"`
		BigSystem int     `json:"bigSystem"`
		AdvanceMs int64   `json:"advanceMs"`
		StartMs   int64   `json:"startMs"`
		EndMs     int64   `json:"endMs"`
		Events    []event `json:"events"`
		Reply     struct {
			Status  int               `json:"status"`
			OK      bool              `json:"ok"`
			Headers map[string]string `json:"headers"`
			Body    string            `json:"body"`
		} `json:"reply"`
		Rows []struct {
			ID        string  `json:"id"`
			IsActive  float64 `json:"isActive"`
			Data      string  `json:"data"`
			UpdatedAt string  `json:"updatedAt"`
		} `json:"rows"`
	} `json:"requests"`
}

type event struct {
	Send    *string `json:"send"`
	Sleep   float64 `json:"sleep"`
	By      string  `json:"by"`
	Attempt *struct {
		ConnectionID   string  `json:"connectionId"`
		Model          string  `json:"model"`
		Success        bool    `json:"success"`
		Status         int     `json:"status"`
		Error          string  `json:"error"`
		ResetsAtMs     float64 `json:"resetsAtMs"`
		HeadersTimeout *struct {
			Stream bool `json:"stream"`
		} `json:"headersTimeout"`
	} `json:"attempt"`
}

func (e event) String() string {
	switch {
	case e.Send != nil:
		return "send " + *e.Send
	case e.Attempt != nil:
		return fmt.Sprintf("attempt %s %d", e.Attempt.ConnectionID, e.Attempt.Status)
	}
	return fmt.Sprintf("sleep %s %v", e.By, e.Sleep)
}

// ccHeaders are the recorder's client headers.
var ccHeaders = map[string]string{
	"content-type": "application/json", "user-agent": "claude-cli/2.1.258 (external, cli)", "x-app": "cli", "anthropic-version": "2023-06-01",
}

// bodyFor is the recorder's bodyFor.
func bodyFor(t *testing.T, model string, bigSystem int) *claudeprep.Value {
	t.Helper()
	b := jsjson.NewObject()
	b.Set("model", model)
	b.Set("max_tokens", 1024.0)
	b.Set("stream", true)
	if bigSystem > 0 {
		block := jsjson.NewObject()
		block.Set("type", "text")
		block.Set("text", strings.Repeat("lorem ", bigSystem))
		cc := jsjson.NewObject()
		cc.Set("type", "ephemeral")
		block.Set("cache_control", cc)
		b.Set("system", []any{block})
	}
	msg := jsjson.NewObject()
	msg.Set("role", "user")
	msg.Set("content", "Explain the build failure in step three.")
	b.Set("messages", []any{msg})
	v, err := claudeprep.Parse(jsjson.Marshal(b))
	if err != nil {
		t.Fatal(err)
	}
	return v
}

func TestFallbackMatchesNode(t *testing.T) {
	raw, err := os.ReadFile("testdata/fallback.json")
	if err != nil {
		t.Fatal(err)
	}
	var file fallbackFile
	if err := json.Unmarshal(raw, &file); err != nil {
		t.Fatal(err)
	}
	if len(file) < 14 {
		t.Fatalf("only %d scenarios", len(file))
	}
	for _, sc := range file {
		t.Run(sc.Name, func(t *testing.T) {
			var clock atomic.Int64
			clock.Store(sc.Requests[0].StartMs - sc.Requests[0].AdvanceMs)
			now := func() time.Time { return time.UnixMilli(clock.Load()) }
			nowMs := func() float64 { return float64(clock.Load()) }
			path, node := dbtest.New(t, dbtest.Options{})
			dbtest.InsertRows(t, node, sc.Initial)
			if sc.Settings != nil {
				dbtest.Exec(t, node, `INSERT INTO settings(id, data) VALUES(1, ?)`, *sc.Settings)
			}
			d, err := db.Open(path, db.Options{Now: now})
			if err != nil {
				t.Fatal(err)
			}
			defer d.Close()
			ctx := context.Background()
			snap, err := d.LoadSnapshot(ctx)
			if err != nil {
				t.Fatal(err)
			}
			cfg := FromSnapshot(snap)
			a := accounts.New(d)
			a.Now = now
			a.Random = func() float64 { return 0.5 }

			for i, r := range sc.Requests {
				clock.Add(r.AdvanceMs)
				if clock.Load() != r.StartMs {
					t.Fatalf("request %d starts at %d, Node %d", i, clock.Load(), r.StartMs)
				}
				body := bodyFor(t, r.Model, r.BigSystem)
				plan, err := Plan(PlanInput{Config: cfg, Settings: snap.Settings, Model: r.Model, Body: body, Headers: ccHeaders})
				if err != nil {
					t.Fatalf("request %d: %v", i, err)
				}
				next := 0
				take := func(what string) event {
					t.Helper()
					if next >= len(r.Events) {
						t.Fatalf("request %d: Go %s after Node's last event", i, what)
					}
					e := r.Events[next]
					next++
					return e
				}
				sleeper := func(by string) func(context.Context, float64) error {
					return func(_ context.Context, ms float64) error {
						e := take("waits " + by)
						if e.Sleep == 0 || e.By != by || e.Sleep != ms {
							t.Fatalf("request %d: Go waits %s %vms, Node's next event is %s", i, by, ms, e)
						}
						clock.Add(int64(ms))
						return nil
					}
				}
				leaf := func(ctx context.Context, provider, model string) (accounts.Outcome, error) {
					attempt := func(ctx context.Context, c *db.Connection) (accounts.AttemptResult, error) {
						for {
							e := take("tries " + c.ID)
							switch {
							case e.Send != nil:
								if *e.Send != c.ID {
									t.Fatalf("request %d: Go tries %s, Node sent with %s", i, c.ID, *e.Send)
								}
							case e.Attempt == nil && (e.By == "retry" || e.By == "upstream"):
								// The executor's retry delay, or the upstream's own time.
								clock.Add(int64(e.Sleep))
							case e.Attempt != nil:
								at := e.Attempt
								if at.ConnectionID != c.ID || at.Model != model {
									t.Fatalf("request %d: Go tries %s/%s, Node %s/%s", i, c.ID, model, at.ConnectionID, at.Model)
								}
								res := accounts.AttemptResult{Success: at.Success, Status: at.Status, Error: at.Error, ResetsAtMs: at.ResetsAtMs}
								if at.HeadersTimeout != nil {
									res.HeadersTimeout, res.TimeoutStream = true, at.HeadersTimeout.Stream
								}
								return res, nil
							default:
								t.Fatalf("request %d: Node waits %s inside an attempt", i, e)
							}
						}
					}
					return a.RunModel(ctx, accounts.LoopInput{
						Provider: provider, Model: model, Body: body, Headers: ccHeaders, Settings: snap.Settings,
						ByteSent: func() bool { return false },
						Sleep:     sleeper("warm"),
						Transport: func(c *db.Connection) (string, error) {
							r, err := upstream.ResolveRoute(ctx, c.ProviderSpecificData(), c.Provider, snap.Settings, d)
							return r.Transport(), err
						},
						Check: func(c *db.Connection) error { return upstream.Preflight(ctx, c, snap.Settings, d, noEnv) },
					}, attempt)
				}
				preflight := realPreflight(t, a, snap.Settings, d, body)
				res, err := Run(ctx, plan, Env{Leaf: leaf, Preflight: preflight, Sleep: sleeper("combo"), NowMs: nowMs})
				if sc.GoHandoff != "" && i == len(sc.Requests)-1 {
					var h *accounts.Handoff
					if !errors.As(err, &h) || !strings.Contains(err.Error(), sc.GoHandoff) {
						t.Fatalf("request %d: want a handoff naming %q, got %v", i, sc.GoHandoff, err)
					}
					return
				}
				if err != nil {
					t.Fatalf("request %d: %v", i, err)
				}
				if next != len(r.Events) {
					t.Fatalf("request %d: Node went on with %v", i, r.Events[next:])
				}
				switch {
				case r.Reply.OK:
					if !res.Success {
						t.Fatalf("request %d: Node served it, Go answers %d %s", i, res.Response.Status, res.Response.Body)
					}
				default:
					if res.Success || res.Response.Status != r.Reply.Status || string(res.Response.Body) != r.Reply.Body {
						t.Fatalf("request %d:\n go   %d %s\n node %d %s", i, res.Response.Status, res.Response.Body, r.Reply.Status, r.Reply.Body)
					}
					got := map[string]string{}
					for _, h := range res.Response.Header {
						got[strings.ToLower(h.Name)] = h.Value
					}
					if fmt.Sprint(got) != fmt.Sprint(r.Reply.Headers) {
						t.Fatalf("request %d headers: go %v, node %v", i, got, r.Reply.Headers)
					}
				}
				if clock.Load() != r.EndMs {
					t.Fatalf("request %d ends at %d, Node %d", i, clock.Load(), r.EndMs)
				}
				rows, err := d.ListConnections(ctx, "", nil)
				if err != nil {
					t.Fatal(err)
				}
				byID := map[string]*db.Connection{}
				for _, c := range rows {
					byID[c.ID] = c
				}
				for _, want := range r.Rows {
					c := byID[want.ID]
					if c == nil {
						t.Fatalf("request %d: no row %s", i, want.ID)
					}
					if c.Data.String() != want.Data || c.IsActive != (want.IsActive == 1) || c.UpdatedAt != want.UpdatedAt {
						t.Errorf("request %d row %s:\n go   %s %v %s\n node %s %v %s", i, want.ID, c.Data.String(), c.IsActive, c.UpdatedAt, want.Data, want.IsActive, want.UpdatedAt)
					}
				}
			}
		})
	}
}

// capabilityFile is testdata/capabilities.json: detectRequiredCapabilities
// on many bodies.
type capabilityFile []struct {
	Body     json.RawMessage `json:"body"`
	Required []string        `json:"required"`
}

func TestCapabilityCheckNeverMissesNode(t *testing.T) {
	raw, err := os.ReadFile("testdata/capabilities.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases capabilityFile
	if err := json.Unmarshal(raw, &cases); err != nil {
		t.Fatal(err)
	}
	conservative := 0
	for _, c := range cases {
		v, err := claudeprep.Parse(c.Body)
		if err != nil {
			t.Fatal(err)
		}
		needs, err := MayNeedCapability(v)
		if err != nil {
			t.Fatalf("%s: %v", c.Body, err)
		}
		if len(c.Required) > 0 && !needs {
			t.Errorf("%s: Node needs %v, Go would serve it", c.Body, c.Required)
		}
		if len(c.Required) == 0 && needs {
			conservative++
		}
	}
	// Go may be stricter than Node; keep that to the cases it is on purpose.
	if conservative > 4 {
		t.Errorf("%d bodies Node routes without a capability are declined", conservative)
	}
}

func TestPlanDeclines(t *testing.T) {
	cfg := &Config{
		Nodes: []Node{
			{ID: "openai-compatible-chat-hot", Type: "openai-compatible", Prefix: "hot", HasPrefix: true},
			{ID: "anthropic-compatible-x", Type: "anthropic-compatible", Prefix: "anth", HasPrefix: true},
		},
		Combos: map[string]any{
			"main": []any{"hot/m1"}, "self": []any{"self"}, "other": []any{"anth/m1"}, "bad": []any{"hot/.."},
			"lost": []any{"empty"}, "empty": []any{}, "deep1": []any{"deep2"}, "deep2": []any{"deep3"}, "deep3": []any{"deep4"}, "deep4": []any{"deep5"}, "deep5": []any{"hot/m1"},
		},
		Aliases: jsjson.NewObject(),
	}
	settings := func(kv ...any) accounts.Settings {
		o := jsjson.NewObject()
		for i := 0; i < len(kv); i += 2 {
			o.Set(kv[i].(string), kv[i+1])
		}
		return objSettings{o}
	}
	strategies := func(name, strategy string) *jsjson.Object {
		entry := jsjson.NewObject()
		entry.Set("fallbackStrategy", strategy)
		o := jsjson.NewObject()
		o.Set(name, entry)
		return o
	}
	plain := func(t *testing.T) *claudeprep.Value { return bodyFor(t, "x", 0) }
	parse := func(t *testing.T, s string) *claudeprep.Value {
		v, err := claudeprep.Parse([]byte(s))
		if err != nil {
			t.Fatal(err)
		}
		return v
	}
	yes := true
	cases := []struct {
		name, model, want string
		settings          accounts.Settings
		body              func(*testing.T) *claudeprep.Value
		headers           map[string]string
		hold              *bool
	}{
		{name: "bare id", model: "m1", want: "bare model id"},
		{name: "fusion", model: "main", want: "fusion", settings: settings("comboStrategies", strategies("main", "fusion"))},
		{name: "global round-robin", model: "main", want: "round-robin", settings: settings("comboStrategy", "round-robin")},
		{name: "strategies not an object", model: "main", want: "comboStrategies", settings: settings("comboStrategies", "main")},
		{name: "limit hold", model: "main", want: "limit hold", settings: settings("limitHoldEnabled", 1.0)},
		{name: "a key's limit hold", model: "main", want: "limit hold", hold: &yes},
		{name: "self nesting", model: "self", want: "nested in itself"},
		{name: "too deep", model: "deep1", want: "too deeply"},
		{name: "other provider", model: "other", want: "not an openai-compatible"},
		{name: "bad model id", model: "bad", want: "modelIdProblem"},
		{name: "unresolved member", model: "lost", want: "no provider"},
		{name: "codex", model: "main", want: "Codex", headers: map[string]string{"user-agent": "codex-tui/1.0"}},
		{name: "image", model: "main", want: "capability", body: func(t *testing.T) *claudeprep.Value {
			return parse(t, `{"model":"main","messages":[{"role":"user","content":[{"type":"image","source":{"type":"base64","media_type":"image/png","data":"x"}}]}]}`)
		}},
		{name: "web search", model: "main", want: "web search", body: func(t *testing.T) *claudeprep.Value {
			return parse(t, `{"model":"main","messages":[{"role":"user","content":"x"}],"tools":[{"type":"web_search_20250305","name":"web_search"}]}`)
		}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			s := c.settings
			if s == nil {
				s = settings()
			}
			body := plain
			if c.body != nil {
				body = c.body
			}
			h := c.headers
			if h == nil {
				h = ccHeaders
			}
			_, err := Plan(PlanInput{Config: cfg, Settings: s, Model: c.model, Body: body(t), Headers: h, KeyLimitHold: c.hold})
			if !decline.Is(err) || !strings.Contains(err.Error(), c.want) {
				t.Fatalf("want a decline naming %q, got %v", c.want, err)
			}
		})
	}
	// And the shapes it serves.
	for _, model := range []string{"main", "hot/m1", "deep2"} {
		p, err := Plan(PlanInput{Config: cfg, Settings: settings(), Model: model, Body: plain(t), Headers: ccHeaders})
		if err != nil || p == nil {
			t.Fatalf("%s: %v", model, err)
		}
	}
}

func noEnv(string) string { return "" }

// realPreflight is the preflight part 3 wires: the provider's strategy and
// keys (accounts.CheckProvider), each key's sending settings
// (upstream.Preflight), and a dry run of Prepare for the key and model.
func realPreflight(t *testing.T, a *accounts.Accounts, s db.Settings, d *db.DB, body *claudeprep.Value) func(context.Context, string, string) error {
	t.Helper()
	raw := claudeprep.Marshal(body)
	return func(ctx context.Context, provider, model string) error {
		return a.CheckProvider(ctx, provider, s, func(c *db.Connection) error {
			key, _ := c.Data.Get("apiKey")
			apiKey, _ := key.(string)
			return upstream.PreflightKey(ctx, c, s, d, noEnv, func(n claudeprep.NodeSettings) (*claudeprep.Request, error) {
				return claudeprep.Prepare(raw, claudeprep.Inputs{Provider: provider, Model: model, ClientHeaders: ccHeaders, Connection: claudeprep.Connection{APIKey: apiKey, Node: n}})
			})
		})
	}
}

// What a member's loop would decline on configuration alone, a provider's
// strategy or a key Prepare refuses, is declined before the first member
// sends anything.
func TestPreflightCatchesStrategiesAndPrepare(t *testing.T) {
	raw, err := os.ReadFile("testdata/fallback.json")
	if err != nil {
		t.Fatal(err)
	}
	var file fallbackFile
	if err := json.Unmarshal(raw, &file); err != nil {
		t.Fatal(err)
	}
	var base *struct {
		initial map[string][]map[string]any
	}
	for _, sc := range file {
		if sc.Name == "a combo falls through to its next member" {
			base = &struct{ initial map[string][]map[string]any }{sc.Initial}
		}
	}
	if base == nil {
		t.Fatal("no base scenario")
	}
	cases := []struct {
		name, settings, want string
		edit                 func(rows []map[string]any)
	}{
		{name: "a member's provider uses soonest-reset", want: "soonest-reset",
			settings: `{"requireApiKey":false,"providerStrategies":{"openai-compatible-chat-cold":{"fallbackStrategy":"soonest-reset"}}}`},
		{name: "a member's sticky limit isn't a number", want: "stickyRoundRobinLimit",
			settings: `{"requireApiKey":false,"providerStrategies":{"openai-compatible-chat-cold":{"fallbackStrategy":"round-robin","stickyRoundRobinLimit":"3"}}}`},
		{name: "a key whose model isn't routed to Messages", want: "claudeprep", settings: `{"requireApiKey":false}`,
			edit: func(rows []map[string]any) {
				for _, r := range rows {
					if r["id"] == "c1" {
						r["data"] = `{"apiKey":"key-c1","providerSpecificData":{"apiType":"chat","baseUrl":"https://gateway.example.test/v1","modelRoutes":{"m2":"anthropic"}}}`
					}
				}
			}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			initial := map[string][]map[string]any{}
			for k, rows := range base.initial {
				for _, r := range rows {
					cp := map[string]any{}
					for kk, v := range r {
						cp[kk] = v
					}
					initial[k] = append(initial[k], cp)
				}
			}
			if c.edit != nil {
				c.edit(initial["providerConnections"])
			}
			path, node := dbtest.New(t, dbtest.Options{})
			dbtest.InsertRows(t, node, initial)
			dbtest.Exec(t, node, `INSERT INTO settings(id, data) VALUES(1, ?)`, c.settings)
			d, err := db.Open(path, db.Options{})
			if err != nil {
				t.Fatal(err)
			}
			defer d.Close()
			ctx := context.Background()
			snap, err := d.LoadSnapshot(ctx)
			if err != nil {
				t.Fatal(err)
			}
			body := bodyFor(t, "main", 0)
			plan, err := Plan(PlanInput{Config: FromSnapshot(snap), Settings: snap.Settings, Model: "main", Body: body, Headers: ccHeaders})
			if err != nil {
				t.Fatal(err)
			}
			a := accounts.New(d)
			_, err = Run(ctx, plan, Env{
				Leaf: func(context.Context, string, string) (accounts.Outcome, error) {
					t.Fatal("a member ran before the preflight declined")
					return accounts.Outcome{}, nil
				},
				Preflight: realPreflight(t, a, snap.Settings, d, body),
				NowMs:     func() float64 { return 0 },
			})
			if !decline.Is(err) || !strings.Contains(err.Error(), c.want) {
				t.Fatalf("want a decline naming %q, got %v", c.want, err)
			}
		})
	}
}

// A provider the loop would have to decline later is declined before the
// first member sends anything.
func TestPreflightDeclinesBeforeAnySend(t *testing.T) {
	plan := &Target{Combo: "main", Members: []*Target{
		{Provider: "openai-compatible-chat-a", Model: "m"},
		{Combo: "inner", Members: []*Target{{Provider: "openai-compatible-chat-b", Model: "m"}, {Provider: "openai-compatible-chat-a", Model: "m2"}}},
	}}
	var checked []string
	_, err := Run(context.Background(), plan, Env{
		Leaf: func(context.Context, string, string) (accounts.Outcome, error) {
			t.Fatal("a member ran before the preflight finished")
			return accounts.Outcome{}, nil
		},
		Preflight: func(_ context.Context, provider, _ string) error {
			checked = append(checked, provider)
			if provider == "openai-compatible-chat-b" {
				return decline.New("upstream", "a proxy pool")
			}
			return nil
		},
		NowMs: func() float64 { return 0 },
	})
	if !decline.Is(err) || strings.Join(checked, ",") != "openai-compatible-chat-a,openai-compatible-chat-b" {
		t.Fatalf("err %v, checked %v", err, checked)
	}
}

type objSettings struct{ o *jsjson.Object }

func (s objSettings) Get(key string) (any, bool) { return s.o.Get(key) }
