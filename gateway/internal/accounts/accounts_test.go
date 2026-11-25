package accounts

import (
	"context"
	"encoding/json"
	"math"
	"os"
	"reflect"
	"sort"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/some-du6e/10router/gateway/internal/claudeprep"
	"github.com/some-du6e/10router/gateway/internal/db"
	"github.com/some-du6e/10router/gateway/internal/db/dbtest"
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

// value parses a fixture's JSON into claudeprep's tree.
func value(t *testing.T, raw json.RawMessage) *claudeprep.Value {
	t.Helper()
	v, err := claudeprep.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	return v
}

type vectorFile struct {
	FallbackCases []struct {
		Status int    `json:"status"`
		Text   string `json:"text"`
		Level  int    `json:"level"`
		Out    struct {
			ShouldFallback  bool     `json:"shouldFallback"`
			CooldownMs      float64  `json:"cooldownMs"`
			NewBackoffLevel *float64 `json:"newBackoffLevel"`
		} `json:"out"`
	} `json:"fallbackCases"`
	TextCases []struct {
		Status              int    `json:"status"`
		Text                string `json:"text"`
		RequestError        bool   `json:"requestError"`
		LimitError          bool   `json:"limitError"`
		HeadersTimeout      bool   `json:"headersTimeout"`
		NamesAccountOrLimit bool   `json:"namesAccountOrLimit"`
		RequestFault        bool   `json:"requestFault"`
		Signature           *struct {
			Normalized string  `json:"normalized"`
			Exact      *string `json:"exact"`
		} `json:"signature"`
		UpstreamMessage string `json:"upstreamMessage"`
		Normalized      string `json:"normalized"`
	} `json:"textCases"`
	AffinityCases []struct {
		Body    json.RawMessage   `json:"body"`
		Headers map[string]string `json:"headers"`
		Tenant  string            `json:"tenant"`
		Key     *string           `json:"key"`
	} `json:"affinityCases"`
	BodyCases []struct {
		Body      json.RawMessage `json:"body"`
		UsesCache bool            `json:"usesCache"`
		TTLMs     float64         `json:"ttlMs"`
		Tokens    float64         `json:"tokens"`
	} `json:"bodyCases"`
	SummaryCases []struct {
		Failures []fixtureFailure `json:"failures"`
		Out      string           `json:"out"`
	} `json:"summaryCases"`
	LockedCases []struct {
		LastStatus *int             `json:"lastStatus"`
		LastError  *string          `json:"lastError"`
		Creds      *fixtureCreds    `json:"creds"`
		Failures   []fixtureFailure `json:"failures"`
		Out        struct {
			Status  int     `json:"status"`
			Error   *string `json:"error"`
			Swapped bool    `json:"swapped"`
		} `json:"out"`
	} `json:"lockedCases"`
	RetryCases []struct {
		UntilMs float64 `json:"untilMs"`
		Out     string  `json:"out"`
	} `json:"retryCases"`
	UpstreamCases []struct {
		PSD json.RawMessage `json:"psd"`
		Out string          `json:"out"`
	} `json:"upstreamCases"`
	NowMs     float64 `json:"nowMs"`
	HangSteps []struct {
		Op           string          `json:"op"`
		At           float64         `json:"at"`
		RequestID    string          `json:"requestId"`
		ConnectionID string          `json:"connectionId"`
		Stream       bool            `json:"stream"`
		Reason       string          `json:"reason"`
		BudgetMs     float64         `json:"budgetMs"`
		Out          json.RawMessage `json:"out"`
	} `json:"hangSteps"`
}

type fixtureFailure struct {
	Account string `json:"account"`
	Status  int    `json:"status"`
	Error   string `json:"error"`
}

type fixtureCreds struct {
	LastErrorCode any  `json:"lastErrorCode"`
	LastError     any  `json:"lastError"`
	LastErrorOwn  bool `json:"lastErrorOwn"`
}

func failuresOf(fs []fixtureFailure) []accountFailure {
	out := make([]accountFailure, len(fs))
	for i, f := range fs {
		out[i] = accountFailure{account: f.Account, status: f.Status, err: f.Error}
	}
	return out
}

func TestRuleVectorsMatchNode(t *testing.T) {
	var v vectorFile
	readJSON(t, "testdata/vectors.json", &v)
	if len(v.FallbackCases) < 500 || len(v.TextCases) < 200 {
		t.Fatalf("too few vectors: %d %d", len(v.FallbackCases), len(v.TextCases))
	}
	for _, c := range v.FallbackCases {
		got := CheckFallbackError(c.Status, c.Text, c.Level)
		hasNew := c.Out.NewBackoffLevel != nil
		if got.ShouldFallback != c.Out.ShouldFallback || got.CooldownMs != c.Out.CooldownMs || got.HasBackoffLevel != hasNew ||
			(hasNew && float64(got.NewBackoffLevel) != *c.Out.NewBackoffLevel) {
			t.Errorf("checkFallbackError(%d, %q, %d) = %+v, Node %+v", c.Status, c.Text, c.Level, got, c.Out)
		}
	}
	for _, c := range v.TextCases {
		if got := IsRequestError(c.Status, c.Text); got != c.RequestError {
			t.Errorf("isRequestError(%d, %q) = %v", c.Status, c.Text, got)
		}
		if got := IsLimitError(c.Status, c.Text); got != c.LimitError {
			t.Errorf("isLimitError(%d, %q) = %v", c.Status, c.Text, got)
		}
		if got := IsHeadersTimeout(c.Status, c.Text); got != c.HeadersTimeout {
			t.Errorf("isHeadersTimeout(%d, %q) = %v", c.Status, c.Text, got)
		}
		if got := NamesAccountOrLimit(c.Text); got != c.NamesAccountOrLimit {
			t.Errorf("namesAccountOrLimit(%q) = %v", c.Text, got)
		}
		if got := IsRequestFault(c.Status, c.Text); got != c.RequestFault {
			t.Errorf("isRequestFault(%d, %q) = %v", c.Status, c.Text, got)
		}
		norm, exact, hasExact, ok := requestErrorSignatures(c.Status, c.Text)
		switch {
		case ok != (c.Signature != nil):
			t.Errorf("requestErrorSignatures(%d, %q) ok=%v, Node %v", c.Status, c.Text, ok, c.Signature)
		case ok && (norm != c.Signature.Normalized || hasExact != (c.Signature.Exact != nil) || (hasExact && exact != *c.Signature.Exact)):
			t.Errorf("requestErrorSignatures(%d, %q) = %q %q, Node %+v", c.Status, c.Text, norm, exact, c.Signature)
		}
		if got := upstreamMessage(c.Text); got != c.UpstreamMessage {
			t.Errorf("upstreamMessage(%q) = %q, Node %q", c.Text, got, c.UpstreamMessage)
		}
		if got := normalizeErrorMessage(c.Text); got != c.Normalized {
			t.Errorf("normalizeErrorMessage(%q) = %q, Node %q", c.Text, got, c.Normalized)
		}
	}
	for _, c := range v.AffinityCases {
		key, err := CacheAffinityKey("openai-compatible-chat-hot", "m", value(t, c.Body), c.Headers, c.Tenant)
		want := ""
		if c.Key != nil {
			want = *c.Key
		}
		if err != nil || key != want {
			t.Errorf("cacheAffinityKey(%s, %v, %q) = %q %v, Node %q", c.Body, c.Headers, c.Tenant, key, err, want)
		}
	}
	for _, c := range v.BodyCases {
		b := value(t, c.Body)
		if RequestUsesPromptCache(b) != c.UsesCache || CacheTTLMs(b) != c.TTLMs || EstimatePromptTokens(b) != c.Tokens {
			t.Errorf("body %s: uses=%v ttl=%v tokens=%v, Node %+v", c.Body, RequestUsesPromptCache(b), CacheTTLMs(b), EstimatePromptTokens(b), c)
		}
	}
	for _, c := range v.SummaryCases {
		if got := summarize("openai-compatible-chat-hot", "m", failuresOf(c.Failures)); got != c.Out {
			t.Errorf("summarize = %q, Node %q", got, c.Out)
		}
	}
	for _, c := range v.LockedCases {
		last, lastErr, hasLast := 0, "", false
		if c.LastStatus != nil {
			last = *c.LastStatus
		}
		if c.LastError != nil {
			lastErr, hasLast = *c.LastError, true
		}
		var locked *AllLocked
		if c.Creds != nil {
			locked = &AllLocked{LastErrorCode: c.Creds.LastErrorCode, LastError: c.Creds.LastError, LastErrorOwn: c.Creds.LastErrorOwn}
		}
		st, msg, swapped, hasErr := allLockedError(last, lastErr, hasLast, locked, failuresOf(c.Failures))
		wantErr := ""
		if c.Out.Error != nil {
			wantErr = *c.Out.Error
		}
		if st != c.Out.Status || swapped != c.Out.Swapped || hasErr != (c.Out.Error != nil) || msg != wantErr {
			t.Errorf("allLockedError(%v, %v, %+v, %+v) = %d %q %v, Node %+v", c.LastStatus, c.LastError, c.Creds, c.Failures, st, msg, swapped, c.Out)
		}
	}
	for _, c := range v.RetryCases {
		if got := FormatRetryAfter(c.UntilMs, v.NowMs); got != c.Out {
			t.Errorf("formatRetryAfter(%v) = %q, Node %q", c.UntilMs-v.NowMs, got, c.Out)
		}
	}
	for _, c := range v.UpstreamCases {
		psd, err := jsjson.ParseObject(c.PSD)
		if err != nil {
			t.Fatal(err)
		}
		if got := UpstreamOf(psd); got != c.Out {
			t.Errorf("connectionUpstream(%s) = %s, Node %s", c.PSD, got, c.Out)
		}
	}
	h := NewModelHang()
	for i, s := range v.HangSteps {
		var got any
		switch s.Op {
		case "check":
			st := h.Check("openai-compatible-chat-hot", "m", s.RequestID, s.At)
			got = hangJSON(st)
		case "timeout":
			st, hung := h.NoteHeadersTimeout("openai-compatible-chat-hot", "m", s.RequestID, s.ConnectionID, s.Stream, s.Reason, s.At)
			m := map[string]any{"hung": hung}
			if hung {
				m = map[string]any{"hung": true, "checking": st.Checking, "retryAtMs": st.RetryAtMs, "reason": st.Reason}
			}
			got = m
		case "budget":
			h.NoteProbeBudget("openai-compatible-chat-hot", "m", s.RequestID, s.BudgetMs, s.At)
		case "served":
			h.NoteServed("openai-compatible-chat-hot", "m")
		case "release":
			h.ReleaseProbe("openai-compatible-chat-hot", "m", s.RequestID)
		}
		if !sameAsNode(t, got, s.Out) {
			gotJSON, _ := json.Marshal(got)
			t.Errorf("hang step %d %s: %s, Node %s", i, s.Op, gotJSON, s.Out)
		}
	}
}

func hangJSON(st HangStatus) map[string]any {
	if st.Blocked {
		return map[string]any{"blocked": true, "checking": st.Checking, "retryAtMs": st.RetryAtMs, "reason": st.Reason}
	}
	keys := append([]string{}, st.AvoidKeys...)
	sort.Strings(keys)
	return map[string]any{"blocked": false, "probe": st.Probe, "avoidKeys": keys}
}

// sameAsNode compares a Go result with Node's recorded JSON. Node's side goes
// through jsjson, which keeps a lone surrogate half as the WTF-8 bytes Go
// holds (encoding/json would turn it into U+FFFD).
func sameAsNode(t *testing.T, got any, node json.RawMessage) bool {
	t.Helper()
	var want any
	if len(node) > 0 {
		var err error
		if want, err = jsjson.Parse(node); err != nil {
			t.Fatal(err)
		}
	}
	return reflect.DeepEqual(plain(got), plain(want))
}

// plain turns both sides into one shape: maps, []any and float64 numbers.
func plain(v any) any {
	switch x := v.(type) {
	case *jsjson.Object:
		if x == nil {
			return nil
		}
		m := map[string]any{}
		for _, mem := range x.Members() {
			m[mem.Key] = plain(mem.Value)
		}
		return m
	case map[string]any:
		if x == nil {
			return nil
		}
		m := map[string]any{}
		for k, val := range x {
			m[k] = plain(val)
		}
		return m
	case []any:
		out := make([]any, len(x))
		for i, it := range x {
			out[i] = plain(it)
		}
		return out
	case []string:
		out := make([]any, len(x))
		for i, it := range x {
			out[i] = it
		}
		return out
	case int:
		return float64(x)
	case int64:
		return float64(x)
	}
	return v
}

// ── Scenarios ────────────────────────────────────────────────────────────────

type scenarioFile []struct {
	Name       string           `json:"name"`
	GoDeclines string           `json:"goDeclines"`
	StartMs    int64            `json:"startMs"`
	Settings   *string          `json:"settings"`
	Initial    []map[string]any `json:"initial"`
	Steps      []struct {
		Op            string          `json:"op"`
		Model         string          `json:"model"`
		ID            string          `json:"id"`
		Status        int             `json:"status"`
		Error         string          `json:"error"`
		ResetsAtMs    float64         `json:"resetsAtMs"`
		Exclude       []string        `json:"exclude"`
		Warm          []string        `json:"warm"`
		MaxWarmWaitMs float64         `json:"maxWarmWaitMs"`
		Avoid         []string        `json:"avoid"`
		Ms            int64           `json:"ms"`
		NowMs         int64           `json:"nowMs"`
		Out           json.RawMessage `json:"out"`
		Rows          []struct {
			ID        string  `json:"id"`
			IsActive  float64 `json:"isActive"`
			Data      string  `json:"data"`
			UpdatedAt string  `json:"updatedAt"`
		} `json:"rows"`
	} `json:"steps"`
}

func TestScenariosMatchNode(t *testing.T) {
	var file scenarioFile
	readJSON(t, "testdata/scenarios.json", &file)
	if len(file) < 8 {
		t.Fatalf("only %d scenarios", len(file))
	}
	for _, sc := range file {
		t.Run(sc.Name, func(t *testing.T) {
			var clock atomic.Int64
			clock.Store(sc.StartMs)
			now := func() time.Time { return time.UnixMilli(clock.Load()) }
			path, node := dbtest.New(t, dbtest.Options{})
			dbtest.InsertRows(t, node, map[string][]map[string]any{"providerConnections": sc.Initial})
			settings := jsjson.NewObject()
			if sc.Settings != nil {
				dbtest.Exec(t, node, `INSERT INTO settings(id, data) VALUES(1, ?)`, *sc.Settings)
				o, err := jsjson.ParseObject([]byte(*sc.Settings))
				if err != nil {
					t.Fatal(err)
				}
				settings = o
			}
			d, err := db.Open(path, db.Options{Now: now})
			if err != nil {
				t.Fatal(err)
			}
			defer d.Close()
			a := New(d)
			a.Now = now
			a.Random = func() float64 { return 0.5 }
			ctx := context.Background()
			picked := map[string]*db.Connection{}
			set := func(ids []string) map[string]bool {
				m := map[string]bool{}
				for _, id := range ids {
					m[id] = true
				}
				return m
			}
			for i, st := range sc.Steps {
				var got map[string]any
				switch st.Op {
				case "advance":
					clock.Add(st.Ms)
				case "select":
					p, err := a.Select(ctx, "openai-compatible-chat-hot", st.Model, objSettings{settings}, SelectOptions{
						Exclude: set(st.Exclude), Warm: st.Warm, MaxWarmWaitMs: st.MaxWarmWaitMs, Avoid: set(st.Avoid),
					})
					if sc.GoDeclines != "" {
						if !decline.Is(err) || !strings.Contains(err.Error(), sc.GoDeclines) {
							t.Fatalf("step %d: want a %s decline, got %+v %v", i, sc.GoDeclines, p, err)
						}
						return
					}
					if err != nil {
						t.Fatalf("step %d: %v", i, err)
					}
					got = pickJSON(p)
					if p.Conn != nil {
						picked[p.Conn.ID] = p.Conn
					}
				case "fail":
					m, err := a.MarkUnavailable(ctx, st.ID, "openai-compatible-chat-hot", st.Status, st.Error, st.Model, st.ResetsAtMs)
					if err != nil {
						t.Fatalf("step %d: %v", i, err)
					}
					var reset any
					if m.ProviderResetAtMs != 0 {
						reset = m.ProviderResetAtMs
					}
					got = map[string]any{"shouldFallback": m.ShouldFallback, "cooldownMs": m.CooldownMs, "providerResetAtMs": reset}
				case "succeed":
					if err := a.ClearError(ctx, picked[st.ID], st.Model); err != nil {
						t.Fatalf("step %d: %v", i, err)
					}
				}
				if clock.Load() != st.NowMs {
					t.Fatalf("step %d: clock %d, Node %d", i, clock.Load(), st.NowMs)
				}
				var gotAny any
				if got != nil {
					gotAny = got
				}
				if !sameAsNode(t, gotAny, st.Out) {
					gotJSON, _ := json.Marshal(got)
					t.Errorf("step %d %s: %s, Node %s", i, st.Op, gotJSON, st.Out)
				}
				rows, err := d.ListConnections(ctx, "openai-compatible-chat-hot", nil)
				if err != nil {
					t.Fatal(err)
				}
				byID := map[string]*db.Connection{}
				for _, r := range rows {
					byID[r.ID] = r
				}
				for _, want := range st.Rows {
					r := byID[want.ID]
					if r == nil {
						t.Fatalf("step %d: no row %s", i, want.ID)
					}
					if r.Data.String() != want.Data || r.IsActive != (want.IsActive == 1) || r.UpdatedAt != want.UpdatedAt {
						t.Errorf("step %d %s row %s:\n go   %s %v %s\n node %s %v %s", i, st.Op, want.ID, r.Data.String(), r.IsActive, r.UpdatedAt, want.Data, want.IsActive, want.UpdatedAt)
					}
				}
			}
		})
	}
}

type objSettings struct{ o *jsjson.Object }

func (s objSettings) Get(key string) (any, bool) { return s.o.Get(key) }

func pickJSON(p Pick) map[string]any {
	switch {
	case p.WarmRetryAtMs > 0:
		return map[string]any{"warmRetryAtMs": p.WarmRetryAtMs}
	case p.AllLocked != nil:
		l := p.AllLocked
		var reset any
		if l.ProviderResetAtMs != 0 {
			reset = l.ProviderResetAtMs
		}
		return map[string]any{
			"allRateLimited": true, "allLimitsExhausted": l.AllLimitsExhausted, "retryAfter": isoMs(l.RetryAfterMs), "retryAfterHuman": l.RetryAfterHuman,
			"providerResetAtMs": reset, "lastError": l.LastError, "lastErrorCode": l.LastErrorCode, "lastErrorOwn": l.LastErrorOwn,
		}
	case p.Conn != nil:
		return map[string]any{"connectionId": p.Conn.ID, "connectionName": conn{p.Conn}.displayName()}
	}
	return map[string]any{"none": true}
}

func TestCheckProviderDeclinesWhatTheLoopWould(t *testing.T) {
	var file scenarioFile
	readJSON(t, "testdata/scenarios.json", &file)
	template := file[0].Initial[0]
	row := func(id, data string) map[string]any {
		r := map[string]any{}
		for k, v := range template {
			r[k] = v
		}
		r["id"], r["data"] = id, data
		return r
	}
	ok := `{"apiKey":"key-k1","providerSpecificData":{"baseUrl":"https://upstream.test/v1"}}`
	cases := []struct {
		name, data, settings, want string
		check                      error
	}{
		{name: "plain", data: ok},
		{name: "demotion", data: `{"authDemote_m":{"count":3},"providerSpecificData":{}}`, want: "demotion"},
		{name: "a date Node reads its own way", data: `{"lastUsedAt":"yesterday","providerSpecificData":{}}`, want: "accounts"},
		{name: "a base URL WHATWG rewrites", data: `{"providerSpecificData":{"baseUrl":"https://bücher.test/v1"}}`, want: "base URL"},
		{name: "soonest-reset", data: ok, settings: `{"fallbackStrategy":"soonest-reset"}`, want: "soonest-reset"},
		{name: "the sender's check", data: ok, check: decline.New("upstream", "a proxy pool"), want: "proxy pool"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			path, node := dbtest.New(t, dbtest.Options{})
			dbtest.InsertRows(t, node, map[string][]map[string]any{"providerConnections": {row("k1", c.data)}})
			d, err := db.Open(path, db.Options{})
			if err != nil {
				t.Fatal(err)
			}
			defer d.Close()
			settings := jsjson.NewObject()
			if c.settings != "" {
				if settings, err = jsjson.ParseObject([]byte(c.settings)); err != nil {
					t.Fatal(err)
				}
			}
			err = New(d).CheckProvider(context.Background(), "openai-compatible-chat-hot", objSettings{settings}, func(*db.Connection) error { return c.check })
			switch {
			case c.want == "" && err != nil:
				t.Fatal(err)
			case c.want != "" && (!decline.Is(err) || !strings.Contains(err.Error(), c.want)):
				t.Fatalf("want a decline naming %q, got %v", c.want, err)
			}
		})
	}
}

func TestJSLengthAndPlainBaseURL(t *testing.T) {
	// A lone surrogate half (WTF-8 ED A0 BD) is one code unit; an emoji two.
	if n := utf16Len("a\xed\xa0\xbdb\U0001F600"); n != 5 {
		t.Fatalf("utf16Len = %d", n)
	}
	for s, want := range map[string]bool{
		"https://upstream.test/v1": true, "https://upstream.test:8443/v1": true, "": true,
		"https://[::1]:8443/v1": false, "https://bücher.test/v1": false, "https://upstream.test:0443/v1": false,
		"https://user@upstream.test/v1": false, `https://upstream.test\v1`: false, "https://upstream.test /v1": false,
	} {
		if got := plainBaseURL(s); got != want {
			t.Errorf("plainBaseURL(%q) = %v", s, got)
		}
	}
	if err := Ready(); err != nil {
		t.Fatal(err)
	}
}

func TestUTF16Prefix(t *testing.T) {
	if got := utf16Prefix("ab\U0001F600c", 3); got != "ab\xed\xa0\xbd" {
		t.Fatalf("got %q", got)
	}
	if got := utf16Prefix("abc", 10); got != "abc" {
		t.Fatalf("got %q", got)
	}
	if math.IsNaN(QuotaCooldown(0)) {
		t.Fatal("nan")
	}
}
