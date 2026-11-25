package claudeprep

import (
	"strconv"
	"strings"
	"unicode/utf8"
)

// The slice of the WHATWG URL standard the Messages route needs: new
// URL(...).hostname for isAnthropicApiUrl, and URL#toString after
// searchParams.set for a node's query override. URLs outside the plain
// http(s)://host[:port]/path?query shape, where WHATWG would rewrite more
// than this models (IDNA, IPv4 shorthands, dot segments, percent-encoding),
// go to Node.

// badPorts is the Fetch standard's port blocking list: Node's fetch refuses
// these for http(s) ("bad port"), so a base URL on one fails in Node.
var badPorts = map[int]bool{
	0: true, 1: true, 7: true, 9: true, 11: true, 13: true, 15: true, 17: true, 19: true, 20: true, 21: true, 22: true, 23: true,
	25: true, 37: true, 42: true, 43: true, 53: true, 69: true, 77: true, 79: true, 87: true, 95: true, 101: true, 102: true,
	103: true, 104: true, 109: true, 110: true, 111: true, 113: true, 115: true, 117: true, 119: true, 123: true, 135: true,
	137: true, 139: true, 143: true, 161: true, 179: true, 389: true, 427: true, 465: true, 512: true, 513: true, 514: true,
	515: true, 526: true, 530: true, 531: true, 532: true, 540: true, 548: true, 554: true, 556: true, 563: true, 587: true,
	601: true, 636: true, 989: true, 990: true, 993: true, 995: true, 1719: true, 1720: true, 1723: true, 2049: true,
	3659: true, 4045: true, 4190: true, 5060: true, 5061: true, 6000: true, 6566: true, 6665: true, 6666: true, 6667: true,
	6668: true, 6669: true, 6679: true, 6697: true, 10080: true,
}

type parsedURL struct {
	scheme, host, port, path string
	query                    *string
}

func isHostChar(c byte) bool {
	return c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '-' || c == '.'
}

func isPathChar(c byte) bool {
	return isHostChar(c) || strings.IndexByte("_~!$&'()*+,;=:@/%", c) >= 0
}

// parseURL: ok false where new URL() would throw or rewrite beyond this
// model; the caller declines on that, or treats it as "not Anthropic".
func parseURL(s string) (parsedURL, bool) {
	var u parsedURL
	i := strings.Index(s, "://")
	if i <= 0 {
		return u, false
	}
	u.scheme = strings.ToLower(s[:i])
	if u.scheme != "http" && u.scheme != "https" {
		return u, false
	}
	rest := s[i+3:]
	end := strings.IndexAny(rest, "/?#")
	authority := rest
	if end >= 0 {
		authority, rest = rest[:end], rest[end:]
	} else {
		rest = ""
	}
	host := authority
	if c := strings.LastIndexByte(authority, ':'); c >= 0 {
		host, u.port = authority[:c], authority[c+1:]
		if u.port != "" {
			n, err := strconv.Atoi(u.port)
			if err != nil || n > 65535 || strings.TrimLeft(u.port, "0123456789") != "" {
				return u, false
			}
			if badPorts[n] {
				return u, false
			}
			u.port = strconv.Itoa(n)
			if (u.scheme == "https" && n == 443) || (u.scheme == "http" && n == 80) {
				u.port = ""
			}
		}
	}
	h, ok := plainHost(host)
	if !ok {
		return u, false
	}
	u.host = h
	if strings.Contains(rest, "#") {
		return u, false
	}
	path := rest
	if q := strings.IndexByte(rest, '?'); q >= 0 {
		path = rest[:q]
		query := rest[q+1:]
		for j := 0; j < len(query); j++ {
			c := query[j]
			if c <= 0x20 || c >= 0x7F || c == '"' || c == '<' || c == '>' || c == '\'' {
				return u, false
			}
		}
		u.query = &query
	}
	for j := 0; j < len(path); j++ {
		if !isPathChar(path[j]) {
			return u, false
		}
		// fetch sends a bad escape as written; Go's url.Parse refuses it.
		if path[j] == '%' && (j+2 >= len(path) || hexVal(path[j+1]) < 0 || hexVal(path[j+2]) < 0) {
			return u, false
		}
	}
	for _, seg := range strings.Split(path, "/") {
		low := strings.ToLower(seg)
		if seg == "." || seg == ".." || strings.Contains(low, "%2e") {
			return u, false
		}
	}
	if path == "" {
		path = "/"
	}
	u.path = path
	return u, true
}

// plainHost lowercases a host WHATWG keeps as written (ASCII labels, no
// punycode, a canonical dotted quad if numeric); ok false for anything else.
func plainHost(host string) (string, bool) {
	if host == "" {
		return "", false
	}
	for j := 0; j < len(host); j++ {
		if !isHostChar(host[j]) {
			return "", false
		}
	}
	host = strings.ToLower(host)
	labels := strings.Split(strings.TrimSuffix(host, "."), ".")
	for _, l := range labels {
		if l == "" || strings.HasPrefix(l, "xn--") {
			return "", false
		}
	}
	if last := labels[len(labels)-1]; last[0] >= '0' && last[0] <= '9' {
		// IPv4: WHATWG reserializes it (a trailing dot goes), so only the
		// canonical dotted quad is known to stay as written.
		if len(labels) != 4 || strings.HasSuffix(host, ".") {
			return "", false
		}
		for _, l := range labels {
			n, err := strconv.Atoi(l)
			if err != nil || n > 255 || strconv.Itoa(n) != l {
				return "", false
			}
		}
	}
	return host, true
}

// urlHostname is new URL(s).hostname for isAnthropicApiUrl: "" when Node's
// parser would throw (then the host is not Anthropic's). Shapes where the
// answer isn't certain go to Node.
func urlHostname(s string) string {
	i := strings.IndexByte(s, ':')
	if i <= 0 {
		return ""
	}
	for j := 0; j < len(s); j++ {
		if s[j] <= 0x20 || s[j] == 0x7F {
			decline("a base URL with spaces or control characters")
		}
	}
	scheme := strings.ToLower(s[:i])
	if scheme != "http" && scheme != "https" || !strings.HasPrefix(s[i+1:], "//") {
		decline("a base URL that isn't http(s)://")
	}
	rest := s[i+3:]
	if end := strings.IndexAny(rest, "/?#\\"); end >= 0 {
		rest = rest[:end]
	}
	if strings.Contains(rest, "@") {
		decline("a base URL with userinfo")
	}
	host := rest
	if c := strings.LastIndexByte(rest, ':'); c >= 0 {
		host = rest[:c]
		port := rest[c+1:]
		if strings.Trim(port, "0123456789") != "" {
			return ""
		}
		if n, err := strconv.Atoi(port); port != "" && (err != nil || n > 65535) {
			return ""
		}
	}
	h, ok := plainHost(host)
	if !ok {
		decline("a base URL host the port doesn't normalize")
	}
	return h
}

// CanonicalURL is the URL fetch sends for s, as new URL(s).href: the host
// lowercased, a default port dropped, an empty path as "/". ok is false for
// a URL Prepare would have declined.
func CanonicalURL(s string) (string, bool) {
	u, ok := parseURL(s)
	if !ok {
		return "", false
	}
	return u.String(), true
}

func (u parsedURL) String() string {
	s := u.scheme + "://" + u.host
	if u.port != "" {
		s += ":" + u.port
	}
	s += u.path
	if u.query != nil {
		s += "?" + *u.query
	}
	return s
}

type param struct{ name, value string }

// toUSV is a WebIDL USVString conversion: each lone surrogate (its WTF-8
// sequence here) becomes one U+FFFD, as new URLSearchParams(string) does
// before parsing.
func toUSV(s string) string {
	if !strings.Contains(s, "\xed") {
		return s
	}
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		if s[i] == 0xED && i+2 < len(s) && s[i+1] >= 0xA0 && s[i+1] <= 0xBF {
			b.WriteString(string(rune(0xFFFD)))
			i += 2
			continue
		}
		b.WriteByte(s[i])
	}
	return b.String()
}

func percentDecode(s string) []byte {
	out := make([]byte, 0, len(s))
	for i := 0; i < len(s); i++ {
		if s[i] == '%' && i+2 < len(s) {
			h, l := hexVal(s[i+1]), hexVal(s[i+2])
			if h >= 0 && l >= 0 {
				out = append(out, byte(h<<4|l))
				i += 2
				continue
			}
		}
		out = append(out, s[i])
	}
	return out
}

// parseURLEncoded is the application/x-www-form-urlencoded parser.
func parseURLEncoded(s string) []param {
	var out []param
	for _, seq := range strings.Split(s, "&") {
		if seq == "" {
			continue
		}
		name, value, _ := strings.Cut(seq, "=")
		dec := func(x string) string {
			return decodeUTF8KeepBOM(percentDecode(strings.ReplaceAll(x, "+", " ")))
		}
		out = append(out, param{dec(name), dec(value)})
	}
	return out
}

func serializeURLEncoded(params []param) string {
	var b strings.Builder
	enc := func(s string) {
		if !utf8.ValidString(s) {
			s = decodeUTF8KeepBOM([]byte(s))
		}
		for i := 0; i < len(s); i++ {
			c := s[i]
			switch {
			case c == ' ':
				b.WriteByte('+')
			case c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '*' || c == '-' || c == '.' || c == '_':
				b.WriteByte(c)
			default:
				b.WriteByte('%')
				b.WriteByte("0123456789ABCDEF"[c>>4])
				b.WriteByte("0123456789ABCDEF"[c&15])
			}
		}
	}
	for i, p := range params {
		if i > 0 {
			b.WriteByte('&')
		}
		enc(p.name)
		b.WriteByte('=')
		enc(p.value)
	}
	return b.String()
}

// applyURLOverrides is applyUrlOverrides(url, o, { replacePath: false }):
// the route keeps its own path, query parameters are set.
func applyURLOverrides(url string, o *Overrides) string {
	if o.Path == "" && o.Query == "" {
		return url
	}
	u, ok := parseURL(url)
	if !ok {
		decline("a URL the WHATWG parser would rewrite beyond this port")
	}
	// Only searchParams.set rewrites the query: an override that parses to no
	// pairs ("&") leaves it exactly as the URL parser wrote it.
	if sets := parseURLEncoded(toUSV(strings.TrimPrefix(o.Query, "?"))); len(sets) > 0 {
		params := []param{}
		if u.query != nil {
			params = parseURLEncoded(*u.query)
		}
		for _, set := range sets {
			found := false
			kept := params[:0:0]
			for _, p := range params {
				if p.name == set.name {
					if !found {
						kept = append(kept, param{p.name, set.value})
						found = true
					}
					continue
				}
				kept = append(kept, p)
			}
			if !found {
				kept = append(kept, set)
			}
			params = kept
		}
		s := serializeURLEncoded(params)
		if s == "" {
			u.query = nil
		} else {
			u.query = &s
		}
	}
	return u.String()
}
