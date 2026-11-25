package accounts

import (
	"context"
	"net/url"
	"regexp"
	"strconv"
	"strings"

	"github.com/some-du6e/10router/gateway/internal/claudeprep"
	"github.com/some-du6e/10router/gateway/internal/db"
	"github.com/some-du6e/10router/gateway/internal/db/jsjson"
)

// sameRequestError.ts: a request error every key of a custom endpoint would
// refuse stops the account walk once enough accounts agreed on it.

// The module's own regexes (not exported by Node), compiled with
// JavaScript's semantics; the parity fixtures hold them to Node's answers.
var (
	statusPrefixRe    = compileJS(jsRegex{Source: `^\[\d+\]:\s*`})
	requestIDSuffixRe = compileJS(jsRegex{Source: ` ?\(request id: [^)]{0,128}\)`, Flags: "i"})
	digitsRe          = compileJS(jsRegex{Source: `\d+`})
	spacesRe          = compileJS(jsRegex{Source: `\s+`})
	fourDigitsRe      = compileJS(jsRegex{Source: `\d{4,}`})
)

// asText is the error cut to SAME_REQUEST_ERROR_MAX_TEXT UTF-16 units.
func asText(errorText string) string { return utf16Prefix(errorText, tbl.SameRequestError.MaxText) }

// upstreamMessage is sameRequestError.ts's upstreamMessage.
func upstreamMessage(errorText string) string {
	return requestIDSuffixRe.ReplaceAllLiteralString(bodyMessage(errorText), "")
}

func bodyMessage(errorText string) string {
	text := statusPrefixRe.ReplaceAllLiteralString(asText(errorText), "")
	v, err := claudeprep.Parse([]byte(text))
	if err != nil || !(v.IsObject() || v.IsArray()) {
		return text
	}
	// error.message || message || error
	msg := claudeprep.Undefined()
	if e := v.Get("error"); e.IsObject() || e.IsArray() {
		msg = e.Get("message")
	}
	if !msg.Truthy() {
		msg = v.Get("message")
	}
	if !msg.Truthy() {
		msg = v.Get("error")
	}
	if !msg.Truthy() {
		return text
	}
	if msg.IsString() {
		return asText(msg.Str())
	}
	return asText(string(claudeprep.Marshal(msg)))
}

// normalizeErrorMessage: lowercased, digits as "#", whitespace collapsed.
func normalizeErrorMessage(errorText string) string {
	// Only compared with other errors of the same request, all lowered here.
	s := strings.ToLower(upstreamMessage(errorText))
	s = digitsRe.ReplaceAllLiteralString(s, "#")
	s = spacesRe.ReplaceAllLiteralString(s, " ")
	return jsTrim(s)
}

func namesTheKey(status int, text string) bool {
	return NamesAccountOrLimit(text) || IsLimitError(status, text) || keyRefusalRe.MatchString(text) || sameKeyLimitRe.MatchString(text)
}

func anyMatch(res []*regexp.Regexp, s string) bool {
	for _, re := range res {
		if re.MatchString(s) {
			return true
		}
	}
	return false
}

// requestErrorSignatures is requestErrorSignatures: the normalized and, for a
// limit message naming both sizes, the exact form; ok is false when the
// failure doesn't count.
func requestErrorSignatures(status int, errorText string) (normalized, exact string, hasExact, ok bool) {
	if !sameRequestStatus[status] {
		return "", "", false, false
	}
	raw := asText(errorText)
	message := upstreamMessage(raw)
	if namesTheKey(status, message) || namesTheKey(status, raw) {
		return "", "", false, false
	}
	shaped := status == 413 || anyMatch(sameLimitRes, message) || anyMatch(sameShapeRes, message)
	if !shaped {
		return "", "", false, false
	}
	namesLimit := status != 413 && anyMatch(sameLimitRes, message) && len(fourDigitsRe.FindAllString(message, -1)) >= 2
	normalized = strconv.Itoa(status) + " " + normalizeErrorMessage(raw)
	if namesLimit {
		exact, hasExact = strconv.Itoa(status)+" "+strings.ToLower(jsTrim(message)), true
	}
	return normalized, exact, hasExact, true
}

// IsRequestFault is isRequestFault.
func IsRequestFault(status int, errorText string) bool {
	if _, _, _, ok := requestErrorSignatures(status, errorText); !ok {
		return false
	}
	return status != 413 || anyMatch(sameLimitRes, upstreamMessage(errorText)) || anyMatch(sameShapeRes, upstreamMessage(errorText))
}

// Agreement is how far accounts agree on one request error.
type Agreement int

const (
	NoAgreement Agreement = iota
	Normalized
	Exact
)

// sameRequestTally is createSameRequestErrorTally.
type sameRequestTally struct {
	stopAfter, exactAfter int
	members               map[string]map[string]bool
}

func newSameRequestTally() *sameRequestTally {
	return &sameRequestTally{stopAfter: tbl.SameRequestError.StopAfter, exactAfter: max(tbl.SameRequestError.StopAfter, 2), members: map[string]map[string]bool{}}
}

func (t *sameRequestTally) agreeing(sig, member string) int {
	set := t.members[sig]
	if set == nil {
		set = map[string]bool{}
		t.members[sig] = set
	}
	set[member] = true
	return len(set)
}

func (t *sameRequestTally) note(connectionID, upstream string, status int, errorText string) Agreement {
	if t.stopAfter <= 0 {
		return NoAgreement
	}
	normalized, exact, hasExact, ok := requestErrorSignatures(status, errorText)
	if !ok {
		return NoAgreement
	}
	n := t.agreeing("n "+normalized, connectionID)
	if hasExact && t.agreeing("x "+exact, upstream) >= t.exactAfter {
		return Exact
	}
	if n >= t.stopAfter {
		return Normalized
	}
	return NoAgreement
}

// upstreamFields are connectionUpstream.ts's UPSTREAM_FIELDS.
var upstreamFields = []string{"baseUrl", "azureEndpoint", "region", "location", "accountId", "projectId"}

var trailingAPIPath = regexp.MustCompile(`(?i)/(chat/completions|messages|responses)$`)
var trailingSlashes = regexp.MustCompile(`/+$`)

// normalizeEndpointURL is endpointUrl.ts's normalizeEndpointUrl.
// KeysShareOneUpstream is auth.js's keysShareOneUpstream: every active key
// of the provider reaches the same upstream (no key on its own base URL, one
// connectionUpstream) the same way. transport is networkPath(connection)'s
// transport, which the sender resolves.
func (a *Accounts) KeysShareOneUpstream(ctx context.Context, provider string, transport func(*db.Connection) (string, error)) (bool, error) {
	rows, err := a.Store.ListConnections(ctx, provider, nil)
	if err != nil {
		return false, err
	}
	upstreams, transports := map[string]bool{}, map[string]bool{}
	for _, r := range rows {
		if !r.IsActive {
			continue
		}
		psd := r.ProviderSpecificData()
		if v, _ := psd.Get("ownBaseUrl"); jsjson.Truthy(v) {
			return false, nil
		}
		upstreams[UpstreamOf(psd)] = true
	}
	if len(upstreams) > 1 {
		return false, nil
	}
	for _, r := range rows {
		if !r.IsActive {
			continue
		}
		t, err := transport(r)
		if err != nil {
			return false, err
		}
		transports[t] = true
	}
	return len(transports) <= 1, nil
}

func normalizeEndpointURL(s string) string {
	s = jsTrim(s)
	q := strings.IndexByte(s, '?')
	base := s
	if q >= 0 {
		base = s[:q]
	}
	for prev := "\x00"; prev != base; {
		prev = base
		base = trailingAPIPath.ReplaceAllLiteralString(trailingSlashes.ReplaceAllLiteralString(base, ""), "")
	}
	if q >= 0 {
		return base + s[q:]
	}
	return base
}

// jsString is String(v ?? "") for a stored JSON value.
func jsString(v any) string {
	switch t := v.(type) {
	case nil:
		return ""
	case string:
		return t
	case float64, bool:
		return string(jsjson.Marshal(t))
	case []any:
		parts := make([]string, len(t))
		for i, e := range t {
			parts[i] = jsString(e)
		}
		return strings.Join(parts, ",")
	}
	return "[object Object]"
}

// canonicalBaseURL: scheme and host lowercased, a default port dropped,
// trailing slashes dropped; left as normalized when it doesn't parse.
func canonicalBaseURL(raw any) string {
	s := normalizeEndpointURL(jsString(raw))
	u, err := url.Parse(s)
	if err != nil || u.Scheme == "" || u.Host == "" || u.Opaque != "" {
		return s
	}
	scheme := strings.ToLower(u.Scheme)
	host := strings.ToLower(u.Host)
	if (scheme == "http" && strings.HasSuffix(host, ":80")) || (scheme == "https" && strings.HasSuffix(host, ":443")) {
		host = host[:strings.LastIndexByte(host, ':')]
	}
	search := ""
	if u.RawQuery != "" {
		search = "?" + u.RawQuery
	}
	return scheme + "://" + host + trailingSlashes.ReplaceAllLiteralString(u.EscapedPath(), "") + search
}

// UpstreamOf is connectionUpstream: where a key's requests go.
func UpstreamOf(psd *jsjson.Object) string {
	parts := make([]any, len(upstreamFields))
	for i, f := range upstreamFields {
		v, _ := psd.Get(f)
		if f == "baseUrl" {
			parts[i] = canonicalBaseURL(v)
			continue
		}
		parts[i] = trailingSlashes.ReplaceAllLiteralString(jsTrim(jsString(v)), "")
	}
	return string(jsjson.Marshal(parts))
}
