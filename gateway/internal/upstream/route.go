package upstream

import (
	"context"
	"net/url"
	"strings"

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
		return string(jsjson.AppendNumber(nil, t)), nil
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
// other route is a decline.
func (r Resolved) Sendable(env Env, target string) error {
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
