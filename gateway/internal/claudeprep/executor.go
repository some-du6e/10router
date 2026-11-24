package claudeprep

import (
	"regexp"
	"strings"
)

// Port of what DefaultExecutor (open-sse/executors/default.js, base.js) and
// the endpoint overrides wrapped around it
// (open-sse/handlers/chatCore/endpointOverrides.ts,
// src/shared/utils/endpointOverrides.ts) do to one send on the Messages
// route: buildUrl, buildHeaders, transformRequest, then finalizeBody with
// the final headers, then JSON.stringify.

// ALWAYS_STRIPPED in anthropicBeta.ts (not exported there; the fixtures'
// Claude Code beta header holds it to Node's).
var alwaysStrippedBetas = []string{"claude-code-20250219"}

// endpointSettingsPresent is endpointSettings(...) !== null.
func endpointSettingsPresent(n NodeSettings) bool {
	return n.Overrides != nil || n.AuthHeader != "" || (n.Mimic != "" && n.Mimic != "none") || n.BlockForeignTools || n.StripReasoning
}

func (p *prep) execute(body *Value, stream bool) *Request {
	n := p.in.Connection.Node
	// Overrides present implies endpoint settings present.
	if n.Overrides != nil && n.Overrides.Stream == "never" {
		stream = false // connectionOverrides: the send's own stream flag
	}
	url := p.routeURL
	if n.Overrides != nil {
		url = applyURLOverrides(url, n.Overrides)
	}
	headers := p.buildHeaders(stream)
	if endpointSettingsPresent(n) {
		p.applyEndpointHeaders(headers)
	}
	body = p.transformRequest(body)
	if n.Overrides != nil {
		body = applyBodyOverrides(body, n.Overrides)
	}
	body = finalizeBody(body, headers, p.in.Provider, p.models)

	req := &Request{URL: url, Body: Marshal(body), Stream: stream}
	headers.Each(func(k string, v *Value) {
		req.Header = append(req.Header, HeaderField{k, v.str})
	})
	return req
}

// ---- transformRequest -----------------------------------------------------------------

func (p *prep) transformRequest(body *Value) *Value {
	n := p.in.Connection.Node
	// stripUnsupportedParams: Claude models reject temperature.
	if containsFold(p.in.Model, "claude") && !body.Get("temperature").IsUndefined() {
		body.Delete("temperature")
	}
	// The Messages path: fields whose beta flag won't go out.
	body = body.Spread()
	for flag, fields := range tbl.BetaBodyFields {
		if !n.StripBeta && !contains(n.DroppedBetas, flag) {
			continue
		}
		for _, f := range fields {
			body.Delete(f)
		}
	}
	return injectReasoningContent(body, p.in.Model)
}

func containsFold(s, sub string) bool { return indexFold(s, sub) >= 0 }

// injectReasoningContent: model rules only (an openai-compatible node has no
// provider rule).
func injectReasoningContent(body *Value, model string) *Value {
	scope := ""
	switch {
	case len(model) >= 5 && strings.EqualFold(model[:5], "kimi-"):
		scope = "toolCalls"
	case containsFold(model, "deepseek"):
		scope = "all"
	default:
		return body
	}
	msgs := body.Get("messages")
	if !msgs.Truthy() {
		return body
	}
	if !msgs.IsArray() {
		decline("messages is not an array")
	}
	items := msgs.Items()
	out := make([]*Value, len(items))
	for i, m := range items {
		out[i] = m
		if !optional(m).Get("role").Is("assistant") {
			continue
		}
		if rc := m.Get("reasoning_content"); rc.IsString() && rc.str != "" {
			continue
		}
		if scope == "toolCalls" && !(m.Get("tool_calls").IsArray() && m.Get("tool_calls").Len() > 0) {
			continue
		}
		nm := m.Spread()
		nm.Set("reasoning_content", String(" "))
		out[i] = nm
	}
	nb := body.Spread()
	nb.Set("messages", Array(out...))
	return nb
}

// ---- finalizeBody -----------------------------------------------------------------------

func sentBetas(headers *Value) []string {
	var flags []string
	headers.Each(func(k string, v *Value) {
		if strings.ToLower(k) == "anthropic-beta" {
			for _, f := range splitBetas(v.str) {
				if !contains(flags, f) {
					flags = append(flags, f)
				}
			}
		}
	})
	return flags
}

func finalizeBody(body *Value, headers *Value, provider string, models Models) *Value {
	// BaseExecutor: fold tool-change blocks without their beta. The client's
	// were declined up front, but a body override can merge messages that
	// carry them; folding isn't ported, so those go to Node too.
	if msgs := body.Get("messages"); msgs.IsArray() {
		for _, m := range msgs.Items() {
			for _, b := range optional(m).Get("content").Items() {
				if t := optional(b).Get("type"); t.Is("tool_addition") || t.Is("tool_removal") {
					decline("mid-conversation tool change from a body override")
				}
			}
		}
	}
	// DefaultExecutor, Claude format: first-party fields without their beta,
	// then the forced tool_choice rule with the outgoing thinking and model.
	sent := sentBetas(headers)
	var drop []string
	for flag, fields := range tbl.FirstPartyBetaFields {
		if !contains(sent, flag) {
			drop = append(drop, fields...)
		}
	}
	present := false
	for _, f := range drop {
		if body.Has(f) {
			present = true
		}
	}
	if present {
		body = body.Spread()
		for _, f := range drop {
			body.Delete(f)
		}
	}
	relaxForcedToolChoice(body, provider, true, models)
	return body
}

// ---- Headers ---------------------------------------------------------------------------

func splitBetas(v string) []string {
	var out []string
	for _, s := range strings.Split(v, ",") {
		if s = jsTrim(s); s != "" {
			out = append(out, s)
		}
	}
	return out
}

func union(lists ...[]string) []string {
	var out []string
	for _, l := range lists {
		for _, s := range l {
			if !contains(out, s) {
				out = append(out, s)
			}
		}
	}
	return out
}

func (p *prep) buildHeaders(stream bool) *Value {
	in := p.in
	n := in.Connection.Node
	h := Object()
	h.Set("Content-Type", String("application/json"))
	h.Set("anthropic-version", String(anthropicAPIVersion))
	key := in.Connection.APIKey
	if key == "" {
		key = in.Connection.AccessToken
	}
	requireASCIIHeader(key) // the one credential that goes out (apiKey || accessToken)
	h.Set("x-api-key", String(key))
	if beta := in.ClientHeaders["anthropic-beta"]; beta != "" {
		requireASCIIHeader(beta)
		k := "anthropic-beta"
		if !h.Has("anthropic-beta") && h.Has("Anthropic-Beta") {
			k = "Anthropic-Beta"
		}
		h.Set(k, String(strings.Join(union(splitBetas(h.Get(k).Str()), splitBetas(beta)), ",")))
	}
	if !(n.BaseURL == "" || strings.Contains(n.BaseURL, anthropicAPIHost)) {
		if in.Connection.APIKey != "" && !h.Get("Authorization").Truthy() {
			h.Set("Authorization", String("Bearer "+in.Connection.APIKey))
		}
		for _, k := range []string{"anthropic-dangerous-direct-browser-access", "Anthropic-Dangerous-Direct-Browser-Access", "x-app", "X-App"} {
			h.Delete(k)
		}
	}
	drop := append(append([]string{}, alwaysStrippedBetas...), n.DroppedBetas...)
	for _, k := range []string{"anthropic-beta", "Anthropic-Beta"} {
		if !h.Has(k) {
			continue
		}
		var kept []string
		if !n.StripBeta {
			for _, f := range splitBetas(h.Get(k).str) {
				if !contains(drop, f) {
					kept = append(kept, f)
				}
			}
		}
		if len(kept) > 0 {
			h.Set(k, String(strings.Join(kept, ",")))
		} else {
			h.Delete(k)
		}
	}
	if !p.talksToAnthropic() {
		for _, k := range h.Keys() {
			if strings.ToLower(k) != "anthropic-beta" {
				continue
			}
			flags := splitBetas(h.Get(k).str)
			var kept []string
			for _, f := range flags {
				if !contains(firstPartyBetas, f) {
					kept = append(kept, f)
				}
			}
			if len(kept) == len(flags) {
				continue
			}
			if len(kept) > 0 {
				h.Set(k, String(strings.Join(kept, ",")))
			} else {
				h.Delete(k)
			}
		}
	}
	if stream {
		h.Set("Accept", String("text/event-stream"))
	}
	return h
}

func (p *prep) talksToAnthropic() bool {
	base := p.in.Connection.Node.BaseURL
	if base == "" {
		base = "https://" + anthropicAPIHost + "/v1"
	}
	return strings.TrimSuffix(urlHostname(base), ".") == anthropicAPIHost
}

// requireASCIIHeader: fetch sends a header value as a Latin-1 byte string
// (and throws above U+00FF), and String#trim reads 0xA0 as a space; it also
// throws on CR, LF and NUL and trims edge whitespace, while net/http refuses
// other control characters. Printable ASCII without edge spaces goes out the
// same from both.
func requireASCIIHeader(v string) {
	for i := 0; i < len(v); i++ {
		if v[i] >= 0x80 {
			decline("a non-ASCII header value")
		}
		if v[i] < 0x20 || v[i] == 0x7F {
			decline("a header value with control characters")
		}
	}
	if v != "" && (v[0] == ' ' || v[len(v)-1] == ' ') {
		decline("a header value with edge spaces")
	}
}

var headerNameRe = regexp.MustCompile("^[!#$%&'*+.^_`|~0-9A-Za-z-]+$")

type headerOp struct {
	remove      bool
	name, value string
}

// parseHeaderLines is endpointOverrides.ts parseHeaderLines.
func parseHeaderLines(text string) []headerOp {
	var ops []headerOp
	for _, raw := range strings.Split(text, "\n") {
		l := jsTrim(raw)
		if l == "" {
			continue
		}
		if strings.HasPrefix(l, "-") {
			if name := jsTrim(l[1:]); headerNameRe.MatchString(name) {
				ops = append(ops, headerOp{remove: true, name: name})
			}
			continue
		}
		i := strings.IndexByte(l, ':')
		if i <= 0 {
			continue
		}
		name, value := jsTrim(l[:i]), jsTrim(l[i+1:])
		if headerNameRe.MatchString(name) && !strings.ContainsAny(value, "\r\n\x00") {
			requireASCIIHeader(value)
			ops = append(ops, headerOp{name: name, value: value})
		}
	}
	return ops
}

func deleteHeader(h *Value, name string) {
	n := strings.ToLower(name)
	for _, k := range h.Keys() {
		if strings.ToLower(k) == n {
			h.Delete(k)
		}
	}
}

func getHeader(h *Value, name string) (string, bool) {
	n := strings.ToLower(name)
	for _, k := range h.Keys() {
		if strings.ToLower(k) == n {
			return h.Get(k).str, true
		}
	}
	return "", false
}

func setHeader(h *Value, name, value string) {
	deleteHeader(h, name)
	// headers["__proto__"] = "x" is the prototype setter, which ignores a string.
	if name == "__proto__" {
		return
	}
	h.Set(name, String(value))
}

func applyHeaderOps(h *Value, ops []headerOp) {
	for _, o := range ops {
		if o.remove {
			deleteHeader(h, o.name)
		} else {
			setHeader(h, o.name, o.value)
		}
	}
}

func mimicHeaderText(n NodeSettings) string {
	switch n.Mimic {
	case "", "none":
		return ""
	case "custom":
		return n.CustomHeaders
	}
	return tbl.MimicHeaders[n.Mimic]
}

// applyEndpointHeaders: the auth style, the identity preset, the raw header
// lines, then the beta rules (Messages path).
func (p *prep) applyEndpointHeaders(h *Value) {
	n := p.in.Connection.Node
	key := p.in.Connection.APIKey
	if key == "" {
		key = p.in.Connection.AccessToken
	}
	if n.AuthHeader != "" && key != "" {
		for _, name := range []string{"authorization", "x-api-key", "api-key"} {
			deleteHeader(h, name)
		}
		switch n.AuthHeader {
		case "bearer":
			h.Set("Authorization", String("Bearer "+key))
		case "x-api-key":
			h.Set("x-api-key", String(key))
		case "api-key":
			h.Set("api-key", String(key))
		case "both":
			h.Set("Authorization", String("Bearer "+key))
			h.Set("x-api-key", String(key))
		}
	}
	identity := parseHeaderLines(mimicHeaderText(n))
	if current, ok := getHeader(h, "anthropic-beta"); ok && current != "" && n.Mimic != "custom" {
		for i := range identity {
			if !identity[i].remove && strings.ToLower(identity[i].name) == "anthropic-beta" {
				var flags []string
				for _, f := range append(strings.Split(current, ","), strings.Split(identity[i].value, ",")...) {
					if f = jsTrim(f); f != "" && !contains(flags, f) {
						flags = append(flags, f)
					}
				}
				identity[i].value = strings.Join(flags, ",")
				break
			}
		}
	}
	applyHeaderOps(h, identity)
	if n.Overrides != nil {
		applyHeaderOps(h, parseHeaderLines(n.Overrides.Headers))
	}
	if v, ok := getHeader(h, "anthropic-beta"); ok {
		var kept []string
		if !n.StripBeta {
			for _, f := range strings.Split(v, ",") {
				if f = jsTrim(f); f != "" && !contains(n.DroppedBetas, f) {
					kept = append(kept, f)
				}
			}
		}
		if len(kept) > 0 {
			setHeader(h, "anthropic-beta", strings.Join(kept, ","))
		} else {
			deleteHeader(h, "anthropic-beta")
		}
	}
}

// ---- Body overrides --------------------------------------------------------------------

// parseModelRenames is /^\s*(\S+)\s*(?:=>|→)\s*(\S+)\s*$/ per line, the
// greedy left side (the last arrow that leaves two whitespace-free sides).
func parseModelRenames(text string) map[string]string {
	out := map[string]string{}
	for _, l := range strings.Split(text, "\n") {
		t := jsTrim(l)
		best := -1
		bestLen := 0
		for _, arrow := range []string{"=>", "→"} {
			for i := 0; ; {
				j := strings.Index(t[i:], arrow)
				if j < 0 {
					break
				}
				at := i + j
				left, right := strings.TrimRightFunc(t[:at], isJSSpace), strings.TrimLeftFunc(t[at+len(arrow):], isJSSpace)
				if left != "" && right != "" && !hasJSSpace(left) && !hasJSSpace(right) && at > best {
					best, bestLen = at, len(arrow)
				}
				i = at + 1
			}
		}
		if best < 0 {
			continue
		}
		left := strings.TrimRightFunc(t[:best], isJSSpace)
		right := strings.TrimLeftFunc(t[best+bestLen:], isJSSpace)
		if left == "__proto__" {
			continue // a prototype assignment in Node, not a member
		}
		out[left] = right
	}
	return out
}

func hasJSSpace(s string) bool { return strings.IndexFunc(s, isJSSpace) >= 0 }

func dropList(text string) []string {
	return strings.FieldsFunc(text, func(r rune) bool { return r == ',' || isJSSpace(r) })
}

var unsafeKeys = map[string]bool{"__proto__": true, "constructor": true, "prototype": true}

func deepMerge(target, patch *Value) {
	patch.Each(func(k string, v *Value) {
		if unsafeKeys[k] {
			return
		}
		cur := target.Get(k)
		switch {
		case v.Kind() == KindNull:
			target.Delete(k)
		case v.IsObject() && cur.IsObject():
			deepMerge(cur, v)
		default:
			target.Set(k, v.Clone())
		}
	})
}

func applyBodyOverrides(body *Value, o *Overrides) *Value {
	out := body.Clone()
	renames := parseModelRenames(o.Models)
	if m := out.Get("model"); m.IsString() {
		if isProtoName(m.str) {
			decline("a model id Node would look up on Object.prototype")
		}
		if to, ok := renames[m.str]; ok && to != "" {
			out.Set("model", String(to))
		}
	}
	switch o.Stream {
	case "always":
		out.Set("stream", Bool(true))
	case "never":
		out.Set("stream", Bool(false))
		out.Delete("stream_options")
	}
	for _, k := range dropList(o.Drop) {
		out.Delete(k)
	}
	// parseBodyOverride: JSON.parse of the saved text, a string already (so
	// no UTF-8 decoding: a lone surrogate stays, a BOM is a syntax error).
	if jsTrim(o.Body) != "" {
		merge, err := parseText(o.Body)
		if IsDecline(err) {
			decline("a body override the parser doesn't take")
		}
		if err == nil && merge.IsObject() {
			deepMerge(out, merge)
		}
	}
	return out
}
