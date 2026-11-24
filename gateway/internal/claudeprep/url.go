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
		if len(labels) != 4 {
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
			return decodeUTF8(percentDecode(strings.ReplaceAll(x, "+", " ")))
		}
		out = append(out, param{dec(name), dec(value)})
	}
	return out
}

func serializeURLEncoded(params []param) string {
	var b strings.Builder
	enc := func(s string) {
		if !utf8.ValidString(s) {
			s = decodeUTF8([]byte(s))
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
	if o.Query != "" {
		params := []param{}
		if u.query != nil {
			params = parseURLEncoded(*u.query)
		}
		q := strings.TrimPrefix(o.Query, "?")
		for _, set := range parseURLEncoded(q) {
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
