// Package clientip decides who a request comes from, by the same rule as
// custom-server.js (isLoopbackHost, isOnThisMachine, clientKeysFor,
// isTrustedProxyPeer, isTunnelTraffic). Forwarding headers count only from a
// loopback peer (a reverse proxy on this machine) or a peer TRUST_PROXY lists;
// any other remote peer, and a listed one that sent no forwarding header, is
// its socket address.
//
// testdata/parity.json is a table both this package and
// tests/unit/gateway-clientip-parity.test.js (against custom-server.js) check,
// so the two can't drift apart.
package clientip

import (
	"math"
	"net/http"
	"net/netip"
	"strconv"
	"strings"
)

// Headers looks a request header up by lowercase name the way Node's
// req.headers does: "" when absent, repeats joined with ", ", and "host" is
// the Host header.
type Headers func(name string) string

// FromRequest reads r's headers as Node would see them.
func FromRequest(r *http.Request) Headers {
	return func(name string) string {
		if name == "host" {
			return r.Host
		}
		return strings.Join(r.Header.Values(name), ", ")
	}
}

// FromMap reads a map of lowercase header names.
func FromMap(m map[string]string) Headers {
	return func(name string) string { return m[name] }
}

var loopbackHosts = map[string]bool{"localhost": true, "127.0.0.1": true, "::1": true, "0.0.0.0": true}

// IsLoopbackHost accepts a socket address, a Host header (with or without a
// port, IPv6 in brackets) or one X-Forwarded-For entry.
func IsLoopbackHost(value string) bool {
	name := strings.ToLower(strings.TrimSpace(value))
	if name == "" {
		return false
	}
	if strings.HasPrefix(name, "[") {
		end := strings.Index(name, "]")
		if end == -1 {
			return false
		}
		name = name[1:end]
	} else if strings.Count(name, ":") == 1 {
		name = name[:strings.Index(name, ":")]
	}
	name = strings.TrimPrefix(name, "::ffff:")
	return loopbackHosts[name]
}

// forwardingHeaders: any of these from a loopback or listed peer means a proxy
// or tunnel relayed someone else.
var forwardingHeaders = []string{
	"x-forwarded-for", "x-real-ip", "forwarded", "x-forwarded-host", "x-forwarded-proto", "true-client-ip",
	"cf-connecting-ip", "cf-ray", "tailscale-funnel-request",
}

func hasForwardingHeader(h Headers) bool {
	for _, name := range forwardingHeaders {
		if h(name) != "" {
			return true
		}
	}
	return false
}

// Rule is the client-IP rule for one TRUST_PROXY value.
type Rule struct {
	// headerless is TRUST_PROXY=true: a forwarder on this machine that adds no
	// forwarding header, so no loopback peer is local.
	headerless bool
	trusted    []netip.Prefix
}

// NewRule parses TRUST_PROXY as custom-server.js does: "true", or a comma
// list of IPs and CIDRs. An entry that isn't one is skipped.
func NewRule(trustProxy string) *Rule {
	raw := strings.TrimSpace(trustProxy)
	r := &Rule{headerless: strings.ToLower(raw) == "true"}
	if raw == "" || strings.EqualFold(raw, "true") || strings.EqualFold(raw, "false") {
		return r
	}
	for _, entry := range strings.Split(raw, ",") {
		entry = strings.TrimSpace(entry)
		if entry == "" {
			continue
		}
		parts := strings.Split(entry, "/")
		addr, err := netip.ParseAddr(parts[0])
		if err != nil {
			continue
		}
		addr = addr.WithZone("")
		bits := addr.BitLen()
		if len(parts) > 1 {
			n, ok := jsInteger(parts[1])
			if !ok || n < 0 || n > bits {
				// A malformed prefix length trusts nothing.
				continue
			}
			bits = n
		}
		prefix, err := addr.Prefix(bits)
		if err != nil {
			continue
		}
		r.trusted = append(r.trusted, normalizePrefix(prefix))
	}
	return r
}

// jsInteger is Number(text) where the result must be a whole number, as
// net.BlockList's prefix argument must ("" is 0, "0x18" is 24, "24.0" is 24).
func jsInteger(text string) (int, bool) {
	t := strings.TrimSpace(text)
	if t == "" {
		return 0, true
	}
	lower := strings.ToLower(t)
	for _, base := range []struct {
		prefix string
		base   int
	}{{"0x", 16}, {"0o", 8}, {"0b", 2}} {
		if strings.HasPrefix(lower, base.prefix) {
			n, err := strconv.ParseUint(lower[2:], base.base, 32)
			if err != nil || strings.Contains(lower, "_") {
				return 0, false
			}
			return int(n), true
		}
	}
	if strings.Contains(lower, "_") || strings.Contains(lower, "inf") || strings.Contains(lower, "nan") {
		return 0, false
	}
	f, err := strconv.ParseFloat(t, 64)
	if err != nil || f != math.Trunc(f) || math.Abs(f) > 1<<20 {
		return 0, false
	}
	return int(f), true
}

// normalizePrefix turns an IPv4-mapped IPv6 prefix into the IPv4 one, since
// net.BlockList matches mapped and plain IPv4 addresses against each other.
func normalizePrefix(p netip.Prefix) netip.Prefix {
	if p.Addr().Is4In6() && p.Bits() >= 96 {
		v4, err := p.Addr().Unmap().Prefix(p.Bits() - 96)
		if err == nil {
			return v4
		}
	}
	return p
}

func parseIP(text string) (netip.Addr, bool) {
	addr, err := netip.ParseAddr(text)
	if err != nil {
		return netip.Addr{}, false
	}
	return addr.WithZone("").Unmap(), true
}

// IsTrustedProxyPeer reports whether TRUST_PROXY lists socketIP.
func (r *Rule) IsTrustedProxyPeer(socketIP string) bool {
	if len(r.trusted) == 0 || socketIP == "" {
		return false
	}
	address := socketIP
	if strings.HasPrefix(strings.ToLower(address), "::ffff:") {
		address = address[7:]
	}
	addr, ok := parseIP(address)
	if !ok {
		return false
	}
	for _, p := range r.trusted {
		if p.Contains(addr) {
			return true
		}
	}
	return false
}

// isListedProxyHop: a non-loopback peer TRUST_PROXY lists that sent a
// forwarding header, whose headers are read.
func (r *Rule) isListedProxyHop(h Headers, socketIP string) bool {
	return !IsLoopbackHost(socketIP) && r.IsTrustedProxyPeer(socketIP) && hasForwardingHeader(h)
}

// IsOnThisMachine: a loopback peer with no forwarding header, a loopback (or
// absent) Host, and TRUST_PROXY not "true".
func (r *Rule) IsOnThisMachine(h Headers, socketIP string) bool {
	if !IsLoopbackHost(socketIP) || r.headerless || hasForwardingHeader(h) {
		return false
	}
	if host := h("host"); host != "" && !IsLoopbackHost(host) {
		return false
	}
	return true
}

// addressOf is one address from a header, without brackets or port; "" unless
// it is an IP.
func addressOf(value string) string {
	text := strings.TrimSpace(value)
	if strings.HasPrefix(text, "[") {
		end := strings.Index(text, "]")
		if end == -1 {
			text = ""
		} else {
			text = text[1:end]
		}
	} else if strings.Count(text, ":") == 1 {
		text = text[:strings.Index(text, ":")]
	}
	if _, err := netip.ParseAddr(text); err != nil {
		return ""
	}
	return text
}

var (
	ownHostV4 = []netip.Prefix{netip.MustParsePrefix("127.0.0.0/8"), netip.MustParsePrefix("0.0.0.0/8")}
	ownHostV6 = netip.MustParsePrefix("::/64")
)

// isOwnHostAddress: 127.0.0.0/8 and 0.0.0.0/8 (also IPv4-mapped), and ::/64
// outside the mapped range, however they are spelled.
func isOwnHostAddress(address string) bool {
	addr, err := netip.ParseAddr(address)
	if err != nil {
		return false
	}
	addr = addr.WithZone("")
	if addr.Is4() || addr.Is4In6() {
		v4 := addr.Unmap()
		return ownHostV4[0].Contains(v4) || ownHostV4[1].Contains(v4)
	}
	return ownHostV6.Contains(addr)
}

// usableAddress is an address from a header the limiter may key on: an IP
// that isn't this machine.
func usableAddress(value string) string {
	address := addressOf(value)
	if address == "" || IsLoopbackHost(address) || isOwnHostAddress(address) {
		return ""
	}
	return address
}

// ClientKeys returns the addresses to key a login on, the first being the one
// logged: see clientKeysFor in custom-server.js for the reasoning.
func (r *Rule) ClientKeys(h Headers, socketIP string) []string {
	loopback := IsLoopbackHost(socketIP)
	if !loopback && !r.isListedProxyHop(h, socketIP) {
		if socketIP == "" {
			return []string{"unknown"}
		}
		return []string{socketIP}
	}
	if r.IsOnThisMachine(h, socketIP) {
		return []string{socketIP}
	}
	if loopback && r.headerless {
		return []string{"unknown"}
	}
	fromXff := ""
	hops := strings.Split(h("x-forwarded-for"), ",")
	for i := len(hops) - 1; i >= 0 && fromXff == ""; i-- {
		fromXff = usableAddress(hops[i])
	}
	realIPs := strings.Split(h("x-real-ip"), ",")
	fromRealIP := usableAddress(realIPs[len(realIPs)-1])
	var keys []string
	for _, k := range []string{fromXff, fromRealIP} {
		if k != "" && (len(keys) == 0 || keys[0] != k) {
			keys = append(keys, k)
		}
	}
	if len(keys) == 0 {
		if fromCf := usableAddress(h("cf-connecting-ip")); fromCf != "" {
			keys = append(keys, fromCf)
		}
	}
	if len(keys) == 0 {
		return []string{"unknown"}
	}
	return keys
}

// ClientIP is the address logged and keyed on.
func (r *Rule) ClientIP(h Headers, socketIP string) string {
	return r.ClientKeys(h, socketIP)[0]
}

var tunnelHostSuffixes = []string{".trycloudflare.com", ".ts.net"}

// IsTunnelTraffic: a loopback peer whose Host is a Cloudflare quick tunnel or
// a Tailscale name.
func IsTunnelTraffic(h Headers, socketIP string) bool {
	host := h("host")
	if !IsLoopbackHost(socketIP) || host == "" {
		return false
	}
	name := strings.ToLower(strings.TrimSpace(host))
	if !strings.HasPrefix(name, "[") {
		if i := strings.Index(name, ":"); i != -1 {
			name = name[:i]
		}
	}
	name = strings.TrimSuffix(name, ".")
	for _, suffix := range tunnelHostSuffixes {
		if strings.HasSuffix(name, suffix) {
			return true
		}
	}
	return false
}
