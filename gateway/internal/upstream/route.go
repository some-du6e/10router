package upstream

import (
	"context"
	"net/url"
	"os"
	"strings"

	"github.com/some-du6e/10router/gateway/internal/claudeprep"
	"github.com/some-du6e/10router/gateway/internal/db"
	"github.com/some-du6e/10router/gateway/internal/db/jsjson"
)

// Settings are the settings the route reads.
type Settings interface {
	Get(key string) (any, bool)
}

// Pools reads proxy pools (db.DB).
type Pools interface {
	ProxyPoolByID(ctx context.Context, id string) (*db.ProxyPool, error)
}

// Resolved is resolveProxyChain's ResolvedProxy, the fields proxyAwareFetch
// reads.
type Resolved struct {
	Layer                  string // account | provider | global | system
	ConnectionProxyEnabled bool
	ConnectionProxyURL     string
	ConnectionNoProxy      string
	StrictProxy            bool
	VercelRelayURL         string
	Direct                 bool
	BlockedReason          string
}

// Transport is networkPath's transport: the proxy (and its no-proxy list),
// the relay and the Direct flag, as the JSON keysShareOneUpstream compares.
func (r Resolved) Transport() string {
	proxy := ""
	if r.ConnectionProxyEnabled && r.ConnectionProxyURL != "" {
		proxy = r.ConnectionProxyURL
	}
	noProxy := ""
	if proxy != "" {
		noProxy = r.ConnectionNoProxy
	}
	return string(jsjson.Marshal([]any{proxy, noProxy, r.VercelRelayURL, r.Direct}))
}

// str is proxyRouting.ts's str: "" for null, else String(v).trim(). Values
// String() would spell its own way (objects, arrays) are declined.
func str(v any) (string, error) {
	switch t := v.(type) {
	case nil:
		return "", nil
	case string:
		return jsTrim(t), nil
	case float64:
		return jsNum(t), nil
	case bool:
		if t {
			return "true", nil
		}
		return "false", nil
	}
	return "", declined("a proxy setting that is an object or array")
}

// layerSetting is normalizeLayerSetting: a pool id, PROXY_DIRECT, or "" for
// Inherit.
func layerSetting(v any) (string, error) {
	s, err := str(v)
	if err != nil || s == "__none__" {
		return "", err
	}
	return s, nil
}

func get(o *jsjson.Object, key string) any {
	v, _ := o.Get(key)
	return v
}

// ResolveRoute is resolveConnectionProxyConfig(psd, provider) for a stored
// row: the account's pool or Direct, its legacy proxy URL, the provider's
// pool or Direct (settings.providerStrategies), Global's, else the system.
func ResolveRoute(ctx context.Context, psd *jsjson.Object, provider string, s Settings, pools Pools) (Resolved, error) {
	account, err := layerSetting(get(psd, "proxyPoolId"))
	if err != nil {
		return Resolved{}, err
	}
	if account != "" {
		return fromSetting(ctx, account, "account", pools)
	}
	if get(psd, "connectionProxyEnabled") == true {
		legacy, err := str(get(psd, "connectionProxyUrl"))
		if err != nil {
			return Resolved{}, err
		}
		if legacy != "" {
			noProxy, err := str(get(psd, "connectionNoProxy"))
			if err != nil {
				return Resolved{}, err
			}
			return Resolved{Layer: "account", ConnectionProxyEnabled: true, ConnectionProxyURL: legacy, ConnectionNoProxy: noProxy}, nil
		}
	}
	var providerValue any
	strategies, _ := s.Get("providerStrategies")
	switch t := strategies.(type) {
	case nil:
	case *jsjson.Object:
		if entry, ok := get(t, provider).(*jsjson.Object); ok {
			providerValue = get(entry, "proxyPoolId")
		}
	default:
		if jsjson.Truthy(t) {
			return Resolved{}, declined("a providerStrategies setting that isn't an object")
		}
	}
	if p, err := layerSetting(providerValue); err != nil {
		return Resolved{}, err
	} else if p != "" {
		return fromSetting(ctx, p, "provider", pools)
	}
	global, _ := s.Get("globalProxyPoolId")
	if g, err := layerSetting(global); err != nil {
		return Resolved{}, err
	} else if g != "" {
		return fromSetting(ctx, g, "global", pools)
	}
	return Resolved{Layer: "system"}, nil
}

func fromSetting(ctx context.Context, value, layer string, pools Pools) (Resolved, error) {
	if value == tbl.ProxyDirect {
		return Resolved{Layer: layer, Direct: true}, nil
	}
	pool, err := pools.ProxyPoolByID(ctx, value)
	if err != nil {
		return Resolved{}, err
	}
	blocked := func(reason string) (Resolved, error) {
		return Resolved{Layer: layer, StrictProxy: true, BlockedReason: reason}, nil
	}
	if pool == nil {
		return blocked("Proxy pool " + value + " no longer exists")
	}
	name, err := str(get(pool.Data, "name"))
	if err != nil {
		return Resolved{}, err
	}
	label := value
	if v := get(pool.Data, "name"); jsjson.Truthy(v) {
		label = `"` + name + `"`
	}
	if !pool.IsActive {
		return blocked("Proxy pool " + label + " is turned off")
	}
	proxyURL, err := str(get(pool.Data, "proxyUrl"))
	if err != nil {
		return Resolved{}, err
	}
	if proxyURL == "" {
		return blocked("Proxy pool " + label + " has no URL")
	}
	noProxy, err := str(get(pool.Data, "noProxy"))
	if err != nil {
		return Resolved{}, err
	}
	r := Resolved{Layer: layer, ConnectionNoProxy: noProxy, StrictProxy: get(pool.Data, "strictProxy") == true}
	if typ, ok := get(pool.Data, "type").(string); ok && relayType[typ] {
		r.VercelRelayURL = proxyURL
		return r, nil
	}
	r.ConnectionProxyEnabled, r.ConnectionProxyURL = true, proxyURL
	return r, nil
}

// Sendable reports whether the gateway sends a request on this route the
// way proxyAwareFetch would: direct, with no proxy or relay in the way. Any
// other route is a decline, and so is a target whose host net/url reads
// otherwise than WHATWG URL (an IPv6 literal, a non-ASCII name), which the
// NO_PROXY match reads.
func (r Resolved) Sendable(env Env, target string) error {
	if u, err := url.Parse(target); err != nil || strings.ContainsAny(u.Host, "[]") || !printableASCII(u.Host) {
		return declined("a target host net/url and WHATWG URL read differently")
	}
	switch {
	case r.BlockedReason != "":
		return declined("the account's proxy refuses it (Node fails the attempt itself)")
	case r.VercelRelayURL != "":
		return declined("a relay pool")
	case r.ConnectionProxyEnabled && r.ConnectionProxyURL != "":
		return declined("a proxy pool or per-account proxy")
	case r.Direct:
		return nil
	}
	if proxy := envProxyURL(env, target); proxy != "" {
		return declined("the system proxy (HTTP(S)_PROXY) applies")
	}
	return nil
}

func printableASCII(s string) bool {
	for i := 0; i < len(s); i++ {
		if s[i] <= 0x20 || s[i] >= 0x7f {
			return false
		}
	}
	return true
}

// Preflight declines, before anything is sent, a connection this sender
// would have to decline once the account loop reached it: node settings
// Prepare refuses, an endpoint Timeout, Retries or Proxy setting, the TLS
// variables Node reads, the Settings outbound proxy (Node sets HTTP(S)_PROXY
// in its own process, which the gateway can't see), and a route that isn't
// Sendable. accounts.CheckProvider runs it on each key.
func Preflight(ctx context.Context, c *db.Connection, s Settings, pools Pools, env Env) error {
	if env == nil {
		env = os.Getenv
	}
	if err := CheckTLSEnv(env); err != nil {
		return err
	}
	if v, _ := s.Get("outboundProxyEnabled"); jsjson.Truthy(v) {
		return declined("the Settings outbound proxy is on (Node applies it to its own environment)")
	}
	psd := c.ProviderSpecificData()
	node, err := claudeprep.ParseNodeSettings(jsjson.Marshal(psd))
	if err != nil {
		return err
	}
	if o := node.Overrides; o != nil && (o.Timeout != "" || o.Retries != "" || o.Proxy != "") {
		return declined("an endpoint Timeout, Retries or Proxy setting")
	}
	r, err := ResolveRoute(ctx, psd, c.Provider, s, pools)
	if err != nil {
		return err
	}
	return r.Sendable(env, node.BaseURL)
}

// PreflightKey is the whole per-key preflight accounts.CheckProvider takes:
// Preflight, then a dry run of prepare with the key's settings. prepare must
// be the attempt's own (the same Inputs builder for the dry run and the
// send), so a decline Prepare would make mid-loop comes here, first.
func PreflightKey(ctx context.Context, c *db.Connection, s Settings, pools Pools, env Env, prepare Prepare) error {
	if err := Preflight(ctx, c, s, pools, env); err != nil {
		return err
	}
	node, err := claudeprep.ParseNodeSettings(jsjson.Marshal(c.ProviderSpecificData()))
	if err != nil {
		return err
	}
	_, err = prepare(node)
	return err
}

// MergeDroppedBetas is the key's settings with the flags an attempt learned
// (Input.LearnedBetas) added, as Node's next read of the row has them once
// saveDroppedBetas wrote them: a key tried again in the same pass sends
// without them. The flags come from the beta header the attempt sent, so
// sanitizeNodeQuirks keeps them; it keeps at most 50.
func MergeDroppedBetas(n claudeprep.NodeSettings, learned []string) claudeprep.NodeSettings {
	if len(learned) == 0 {
		return n
	}
	merged := appendUnique(n.DroppedBetas, learned...)
	if len(merged) > 50 {
		merged = merged[:50]
	}
	n.DroppedBetas = merged
	return n
}

// envProxyURL is getEnvProxyUrl(target), normalized: the system proxy the
// request would go through, or "".
func envProxyURL(env Env, target string) string {
	first := func(names ...string) string {
		for _, n := range names {
			if v := env(n); v != "" {
				return v
			}
		}
		return ""
	}
	if bypassedByNoProxy(target, first("NO_PROXY", "no_proxy")) {
		return ""
	}
	u, err := url.Parse(target)
	if err != nil {
		return ""
	}
	var raw string
	if u.Scheme == "https" {
		raw = first("HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy")
	} else {
		raw = first("HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy")
	}
	return jsTrim(raw)
}

// bypassedByNoProxy is shouldBypassByNoProxy.
func bypassedByNoProxy(target, noProxy string) bool {
	noProxy = jsTrim(noProxy)
	if noProxy == "" {
		return false
	}
	u, err := url.Parse(target)
	if err != nil {
		return false
	}
	host := strings.ToLower(u.Hostname())
	for _, p := range strings.Split(noProxy, ",") {
		p = strings.ToLower(jsTrim(p))
		switch {
		case p == "":
		case p == "*":
			return true
		case strings.HasPrefix(p, "."):
			if strings.HasSuffix(host, p) || host == p[1:] {
				return true
			}
		case host == p || strings.HasSuffix(host, "."+p):
			return true
		}
	}
	return false
}
