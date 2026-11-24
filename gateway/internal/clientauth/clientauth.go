// Package clientauth decides whether the client may make a native request,
// by Node's rules for /v1 (docs/GO_GATEWAY.md, phase 2):
//
//   - the key, from Authorization: Bearer, x-api-key, x-goog-api-key or ?key=
//     (src/shared/utils/clientApiKey.js);
//   - the public-LLM gate: a management key is refused, and the client must be
//     on this machine or present an active key (src/dashboardGuard.js);
//   - requireApiKey, then the key's expiry, model allowlist and budget
//     (src/sse/handlers/chat.ts, src/sse/services/keyLimits.js,
//     src/shared/utils/apiKeyLimits.js, src/lib/db/repos/apiKeysRepo.js).
//
// The gateway never answers a refusal itself. Every refusal Node would make,
// and anything this package can't decide exactly, is a *DeclineError: the
// request goes to Node, which answers it as it does today. So a check here
// may be stricter than Node's, never looser.
package clientauth

import (
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/some-du6e/10router/gateway/internal/clientip"
	"github.com/some-du6e/10router/gateway/internal/combo"
	"github.com/some-du6e/10router/gateway/internal/db"
	"github.com/some-du6e/10router/gateway/internal/db/jsjson"
)

// DeclineError: Node decides this request (and answers a refusal its way).
type DeclineError struct{ Reason string }

func (e *DeclineError) Error() string { return "clientauth: proxy to Node: " + e.Reason }

func decline(format string, args ...any) error {
	return &DeclineError{fmt.Sprintf(format, args...)}
}

// managementKeyPrefix is managementKey.js's MANAGEMENT_KEY_PREFIX.
const managementKeyPrefix = "10r-mgmt-"

// keyHeaders are the headers extractClientApiKey reads, in its order.
var keyHeaders = []string{"Authorization", "X-Api-Key", "X-Goog-Api-Key"}

// ExtractKey is extractClientApiKey. Node reads a repeated header joined
// (or, for Authorization, keeps one copy), and decodes a value as Latin-1,
// so a repeated key header or a key that isn't printable ASCII is declined.
// So is a request that would fall back to ?key=: URLSearchParams decoding
// isn't restated.
func ExtractKey(h http.Header, rawQuery string) (string, error) {
	for _, name := range keyHeaders {
		if len(h.Values(name)) > 1 {
			return "", decline("repeated %s header", name)
		}
	}
	key, found := "", false
	if auth := h.Get("Authorization"); strings.HasPrefix(auth, "Bearer ") {
		key, found = auth[len("Bearer "):], true
	} else if v := h.Get("X-Api-Key"); v != "" {
		key, found = v, true
	} else if v := h.Get("X-Goog-Api-Key"); v != "" {
		key, found = v, true
	}
	if !found && rawQuery != "" {
		return "", decline("no key header and a query string (Node reads ?key=)")
	}
	for i := 0; i < len(key); i++ {
		if key[i] < 0x20 || key[i] > 0x7e {
			return "", decline("a key that is not printable ASCII")
		}
	}
	return key, nil
}

// Request is what the checks read from the client's request.
type Request struct {
	Header   http.Header
	Host     string
	RawQuery string
	// PeerIP is the client's address as the gateway accepted it.
	PeerIP string
	// Model is the model the limits are checked on: body.model after the
	// [1m] marker strip, as chat.ts passes it.
	Model string
}

// Config is what the checks read from the database.
type Config struct {
	Rule          *clientip.Rule
	RequireAPIKey bool
	// Policy reads a key's row fresh (getApiKeyPolicy); nil, nil when the key
	// is not one 10router issued.
	Policy func(key string) (*db.APIKey, error)
	// Lookup is what allowlist matching reads.
	Lookup *Lookup
	Now    time.Time
}

// Decision is a request the gateway may serve.
type Decision struct {
	// Key is the client's key ("" for none); usage is recorded against it.
	Key string
	// Policy is the key's row, nil for no key or one 10router didn't issue.
	Policy *db.APIKey
	// HasBudget: keyHasBudget. speed and service_tier don't go upstream, and
	// the stream is drained on hang-up for real usage.
	HasBudget bool
	// Local: the client is on this machine (isLocalRequest).
	Local bool
}

// Check runs Node's checks in order. It returns an error, a *DeclineError
// unless the database read failed, whenever Node would refuse the request
// or the answer isn't certain.
func Check(r Request, c Config) (Decision, error) {
	key, err := ExtractKey(r.Header, r.RawQuery)
	if err != nil {
		return Decision{}, err
	}
	// dashboardGuard: refused even from loopback, anywhere in the token.
	if strings.Contains(key, managementKeyPrefix) {
		return Decision{}, decline("a management key (Node answers 401)")
	}
	var policy *db.APIKey
	if key != "" {
		if policy, err = c.Policy(key); err != nil {
			return Decision{}, err
		}
	}
	active := policy != nil && policy.IsActive
	local := isLocalRequest(r, c.Rule)
	// canAccessPublicLlmApi: local, a CLI token, or an active key. A request
	// that gets in only by its CLI token is Node's to serve.
	if !local && !active {
		return Decision{}, decline("not on this machine and no active key (Node answers 401, or checks a CLI token)")
	}
	// chat.ts: requireApiKey.
	if c.RequireAPIKey && !active {
		return Decision{}, decline("requireApiKey without an active key (Node answers 401)")
	}
	// missingModel. JavaScript's trim and the allowlist's lowercasing follow
	// Unicode rules Go's don't match letter for letter.
	if err := asciiID(r.Model); err != nil {
		return Decision{}, err
	}
	if strings.TrimSpace(r.Model) == "" {
		return Decision{}, decline("no model (Node answers 400)")
	}
	d := Decision{Key: key, Policy: policy, Local: local}
	if policy == nil {
		return d, nil
	}
	if err := checkLimits(policy, r.Model, c); err != nil {
		return Decision{}, err
	}
	d.HasBudget = policy.BudgetUsd != nil
	return d, nil
}

// checkLimits is apiKeyLimitDenial: expiry, then the allowlist, then the budget.
func checkLimits(k *db.APIKey, model string, c Config) error {
	if k.ExpiresAt != "" {
		at, err := time.Parse("2006-01-02T15:04:05.000Z", k.ExpiresAt)
		if err != nil {
			return decline("an expiresAt Node's Date parser would read its own way")
		}
		if !at.After(c.Now) {
			return decline("an expired key (Node answers 401)")
		}
	}
	if len(k.AllowedModels) > 0 {
		ok, err := IsModelAllowed(model, k.AllowedModels, c.Lookup, 0)
		if err != nil {
			return err
		}
		if !ok {
			return decline("a model the key's allowlist refuses (Node answers 403)")
		}
	}
	if k.BudgetUsd != nil && k.SpentUsd >= *k.BudgetUsd {
		return decline("a spent budget (Node answers 402)")
	}
	return nil
}

// isLocalRequest is dashboardGuard.js's isLocalRequest for the gateway's own
// client: on this machine by the client-IP rule (custom-server.js stamps
// x-9r-via-proxy otherwise), and no sign of a browser on another page. Any
// Origin makes it not local here; Node accepts a loopback one, so such a
// request needs an active key to go native.
func isLocalRequest(r Request, rule *clientip.Rule) bool {
	h := func(name string) string {
		if name == "host" {
			return r.Host
		}
		return strings.Join(r.Header.Values(name), ", ")
	}
	if rule == nil || !rule.IsOnThisMachine(clientip.Headers(h), r.PeerIP) {
		return false
	}
	if len(r.Header.Values("Origin")) > 0 {
		return false
	}
	if site := h("sec-fetch-site"); site != "" && site != "same-origin" && site != "none" {
		return false
	}
	return true
}

// Lookup is what allowlist matching reads from the router's config
// (keyLimits.js's allowlistLookup).
type Lookup struct {
	Combos *combo.Config
	// Settings for comboStrategies and comboStrategy (a fusion combo's judge
	// is a member too).
	Settings db.Settings
	// Aliases is getModelAliases(), laid over BUILTIN_MODEL_ALIASES.
	Aliases *jsjson.Object
}

// alias is lookup.aliases[raw]: the stored alias, else the built-in one.
func (l *Lookup) alias(raw string) (any, bool) {
	if l != nil {
		if v, ok := l.Aliases.Get(raw); ok {
			return v, true
		}
	}
	if v, ok := combo.BuiltinModelAlias(raw); ok {
		return v, true
	}
	return nil, false
}

// comboMembers is lookup.comboModels: the members, and a fusion combo's judge.
func (l *Lookup) comboMembers(name string) ([]string, error) {
	if l == nil || l.Combos == nil {
		return nil, nil
	}
	members, err := l.Combos.ComboModels(name)
	if err != nil || len(members) == 0 {
		return nil, err
	}
	strategies := l.Settings.Object("comboStrategies")
	key := combo.ComboLookupName(name)
	var strategy *jsjson.Object
	if v, ok := strategies.Get(key); ok {
		strategy, _ = v.(*jsjson.Object)
		if strategy == nil && jsjson.Truthy(v) {
			return nil, decline("combo %q has a strategy entry that is not an object", key)
		}
	}
	fallback, _ := strategy.Get("fallbackStrategy")
	chosen := fallback
	if !jsjson.Truthy(fallback) {
		chosen, _ = l.Settings.Get("comboStrategy")
	}
	if s, _ := chosen.(string); s == "fusion" {
		// The judge counts as a member; fusion combos are Node's anyway.
		return nil, decline("a fusion combo in the allowlist walk")
	}
	return members, nil
}

// asciiID: allowlist matching lowercases and trims with JavaScript's Unicode
// rules, which differ from Go's for a few letters, so only printable ASCII
// is matched here.
func asciiID(s string) error {
	for i := 0; i < len(s); i++ {
		if s[i] < 0x20 || s[i] > 0x7e {
			return decline("an allowlist entry or model that is not printable ASCII")
		}
	}
	if combo.HasProtoKey(s) {
		return decline("an allowlist entry or model naming an Object.prototype member")
	}
	return nil
}

// canonicalModel: "CC/Claude-Opus-5-5[1m]" → "claude/claude-opus-5-5".
func canonicalModel(id string) string {
	t := strings.TrimSpace(id)
	if t == "" {
		return ""
	}
	p := combo.ParseModel(strings.ToLower(t))
	if p.Provider != "" {
		return p.Provider + "/" + p.Model
	}
	return p.Model
}

func matchesAllowed(requested string, allowed map[string]bool) bool {
	if allowed[requested] {
		return true
	}
	slash := strings.IndexByte(requested, '/')
	if slash <= 0 {
		return false
	}
	bare := requested[slash+1:]
	return !strings.Contains(bare, "/") && allowed[bare]
}

// IsModelAllowed is keyLimits.js's isModelAllowed: the model is on the list,
// or is an alias whose target is, or is a combo whose every member is (a
// combo named on the list is allowed whole).
func IsModelAllowed(requested string, allowedModels []string, l *Lookup, depth int) (bool, error) {
	if len(allowedModels) == 0 {
		return true, nil
	}
	if err := asciiID(requested); err != nil {
		return false, err
	}
	for _, e := range allowedModels {
		if err := asciiID(e); err != nil {
			return false, err
		}
	}
	req := canonicalModel(requested)
	if req == "" {
		return false, nil
	}
	allowed := map[string]bool{}
	for _, e := range allowedModels {
		if c := canonicalModel(e); c != "" {
			allowed[c] = true
		}
	}
	raw, _ := combo.StripContextWindowSuffix(strings.TrimSpace(requested))
	namedExactly := func() bool {
		for _, e := range allowedModels {
			if m, _ := combo.StripContextWindowSuffix(strings.TrimSpace(e)); m == raw {
				return true
			}
		}
		return false
	}
	if !strings.Contains(raw, "/") {
		members, err := l.comboMembers(raw)
		if err != nil {
			return false, err
		}
		if len(members) > 0 {
			if namedExactly() || depth >= combo.MaxComboDepth() {
				return true, nil
			}
			for _, m := range members {
				ok, err := IsModelAllowed(m, allowedModels, l, depth+1)
				if err != nil || !ok {
					return false, err
				}
			}
			return true, nil
		}
	}
	if target, ok := l.alias(raw); ok {
		if s, isString := target.(string); isString {
			if err := asciiID(s); err != nil {
				return false, err
			}
			return namedExactly() || matchesAllowed(canonicalModel(s), allowed), nil
		}
	}
	return matchesAllowed(req, allowed), nil
}
