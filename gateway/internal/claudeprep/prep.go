// Package claudeprep is the Go port of Node's Claude request preparation for
// the gateway's hot path (docs/GO_GATEWAY.md, phase 2): POST /v1/messages,
// Claude format in, through a combo member on an openai-compatible-chat-*
// node whose connection routes the model to the Anthropic Messages API (the
// `FMT: claude→claude` line). Node runs its full preparation on that body,
// not a pass-through, and this package reproduces it byte for byte: a
// one-byte difference costs the upstream's prompt cache.
//
// Prepare takes the client's body bytes and the config inputs (Inputs) and
// returns the upstream request Node would send: URL, headers and body bytes.
// It edits a Value tree that keeps JavaScript's key order and number and
// string semantics, so the bytes are JSON.stringify's.
//
// Whatever the port doesn't model it hands back to Node with a *DeclineError
// (the fallback rule: when in doubt, proxy). That includes every input on
// which Node would throw.
//
// Parity: testdata/fixtures holds golden requests recorded from Node by
// tests/unit/gateway-claudeprep-parity.test.js; the Go tests must produce
// exactly their bytes. CI regenerates a larger corpus from the same Node.
package claudeprep

import (
	"errors"
	"fmt"
	"strings"
)

// Inputs is everything besides the body that Node's preparation reads.
// Phase 2b loads these from the database (docs/GO_GATEWAY.md).
type Inputs struct {
	// Provider is the provider node id: "openai-compatible-chat-<uuid>".
	Provider string
	// Model is the combo member's model id as Node's modelInfo.model holds
	// it, a "(level)" thinking suffix included.
	Model string
	// ClientHeaders are the client's request headers, lowercase names (Node's
	// Object.fromEntries(request.headers)).
	ClientHeaders map[string]string
	// KeyHasBudget: the client's API key has a budget, so `speed` and
	// `service_tier` don't go upstream (chat.ts).
	KeyHasBudget bool
	// ProviderThinking is settings.providerThinking[provider].mode, "" when unset.
	ProviderThinking string
	// Connection is the provider connection chosen for this attempt.
	Connection Connection
	// Models resolves capabilities; nil is NewModels(nil).
	Models Models
}

// Connection is the attempt's credentials: its key and providerSpecificData.
type Connection struct {
	APIKey      string
	AccessToken string
	Node        NodeSettings
	// Blocked: the connection's proxy rule refuses it. Node resolves that when
	// it picks the account (getProviderCredentials puts blockedReason over the
	// stored data), then fails the attempt before sending. It is never read
	// from the stored row. strictProxy and direct, resolved the same way, only
	// change how a request is sent: internal/upstream's.
	Blocked bool
}

// NodeSettings is providerSpecificData as the executor reads it: the node's
// settings copied onto the connection (src/shared/utils/nodeQuirks.ts, after
// sanitizeNodeQuirks). A nil slice or map is an absent field.
type NodeSettings struct {
	APIType     string            // "chat" | "responses" | ""
	BaseURL     string            // the node's base URL
	ModelRoutes map[string]string // model -> "anthropic" | "openai-chat" | "openai-responses"
	// DroppedBetas: beta flags the endpoint rejected (learned at runtime).
	DroppedBetas []string
	StripBeta    bool
	// (maxCompletionTokens and apiKeyHeader only change OpenAI paths: unread.)
	AuthHeader    string // "bearer" | "x-api-key" | "api-key" | "both" | ""
	Mimic         string // "none" | "claude-code" | "codex" | "gemini-cli" | "custom" | ""
	CustomHeaders string
	// Overrides is the Ultra advanced block; nil when the node has none
	// (an empty one still counts: Node then applies the other settings too).
	Overrides         *Overrides
	BlockForeignTools bool
	StripReasoning    bool
}

// Overrides is RawOverrides: the user's text, as saved.
type Overrides struct {
	Path, Query, Headers, Body, Drop, Models, Stream string
	// Timeout, Retries and Proxy change how the request is sent, not what:
	// internal/upstream reads them.
	Timeout, Retries, Proxy string
}

// Request is the upstream request Node builds.
type Request struct {
	URL string
	// Header is the executor's headers object in its key order, names as
	// Node spells them.
	Header []HeaderField
	Body   []byte
	// Stream: the upstream is asked for SSE.
	Stream bool
}

// HeaderField is one header.
type HeaderField struct{ Name, Value string }

// DeclineError: the request goes to Node, which prepares it itself.
type DeclineError struct{ Reason string }

func (e *DeclineError) Error() string { return "claudeprep: proxy to Node: " + e.Reason }

type declined struct{ reason string }

func decline(reason string) { panic(declined{reason}) }

// IsDecline reports whether err is a DeclineError.
func IsDecline(err error) bool {
	var d *DeclineError
	return errors.As(err, &d)
}

// Prepare builds the upstream request Node would send for body.
func Prepare(body []byte, in Inputs) (req *Request, err error) {
	defer func() {
		if r := recover(); r != nil {
			d, ok := r.(declined)
			if !ok {
				panic(r)
			}
			req, err = nil, &DeclineError{d.reason}
		}
	}()
	if !strings.HasPrefix(in.Provider, "openai-compatible-") {
		decline("provider is not an openai-compatible node")
	}
	checkID("model", in.Model)
	checkID("provider", in.Provider)
	if in.Connection.APIKey == "" && in.Connection.AccessToken == "" {
		decline("connection has no key")
	}
	if in.Connection.Blocked {
		decline("connection blocked by its proxy rule (Node fails it)")
	}
	if in.Models == nil {
		in.Models = NewModels(nil)
	}
	v, perr := Parse(body)
	if perr != nil {
		return nil, perr
	}
	if !v.IsObject() {
		decline("body is not an object")
	}
	p := &prep{in: in, models: in.Models}
	return p.run(v), nil
}

// checkID: ids reaching the capability patterns and suffix rules are
// printable ASCII, where JavaScript's regexes and case rules match Go's.
func checkID(what, s string) {
	for i := 0; i < len(s); i++ {
		if s[i] < 0x20 || s[i] > 0x7E {
			decline(what + " id is not printable ASCII")
		}
	}
}

type prep struct {
	in     Inputs
	models Models
	// The Anthropic route resolveCompatibleRoute gives this model.
	routeURL string
}

// get is `v.key` where a nullish v is a TypeError in Node.
func get(v *Value, key string) *Value {
	if v.IsNullish() {
		decline(fmt.Sprintf("Node would throw reading %q of %s", key, kindName(v)))
	}
	return v.Get(key)
}

func kindName(v *Value) string {
	if v.Kind() == KindNull {
		return "null"
	}
	return "undefined"
}

func (p *prep) run(body *Value) *Request {
	in := p.in
	declineUnmodelled(body)

	// chat.ts: the context-window marker, a budgeted key's fields, then the
	// member's model on the body chatCore gets.
	if m := body.Get("model"); m.IsString() {
		t := jsTrim(m.str)
		if len(t) >= 4 && strings.EqualFold(t[len(t)-4:], "[1m]") {
			body.Set("model", String(t[:len(t)-4]))
		}
	}
	if in.KeyHasBudget {
		body.Delete("speed")
		body.Delete("service_tier")
	}
	body = body.Spread()
	body.Set("model", String(in.Provider+"/"+in.Model))

	// chatCore.
	body = injectLimitHoldNotice(body)
	p.resolveRoute()

	if mode := in.ProviderThinking; mode != "" && mode != "auto" {
		switch {
		case mode == "on" && !body.Get("thinking").Truthy():
			body = body.Spread()
			body.Set("thinking", obj("type", "enabled", "budget_tokens", 10000))
		case mode == "off" && !body.Get("thinking").Truthy():
			body = body.Spread()
			body.Set("thinking", obj("type", "disabled"))
		case !body.Get("reasoning_effort").Truthy():
			body = body.Spread()
			body.Set("reasoning_effort", String(mode))
		}
	}

	stream := p.stream(body)
	clientTool := detectClientTool(in.ClientHeaders, body)

	stripUnsupportedModalities(body, p.models.Capabilities(in.Provider, in.Model))

	body = p.translate(body)
	body.Delete("_toolNameMap")
	takeToolMetadata(body)
	body.Set("model", String(stripThinkingSuffix(in.Model)))
	stripContinuityFields(body)

	if clientTool == "claude" && body.Get("tools").IsArray() {
		if deduped, stripped := dedupeTools(body.Get("tools").Items()); stripped {
			body.Set("tools", Array(deduped...))
		}
	}
	if t := body.Get("tools"); t.IsArray() {
		body.Set("tools", defaultClaudeToolType(t))
	}
	return p.execute(body, stream)
}

// declineUnmodelled: shapes the port hands to Node whole, found up front.
func declineUnmodelled(body *Value) {
	if tools := body.Get("tools"); tools.IsArray() {
		for _, t := range tools.Items() {
			if optional(t).Get("type").Is(webSearchToolType) {
				decline("web search tool (Node's built-in search hooks)")
			}
		}
	}
	if msgs := body.Get("messages"); msgs.IsArray() {
		for _, m := range msgs.Items() {
			for _, b := range optional(m).Get("content").Items() {
				if t := optional(b).Get("type"); t.Is("tool_addition") || t.Is("tool_removal") {
					decline("mid-conversation tool change")
				}
			}
		}
	} else if msgs.Truthy() {
		decline("messages is not an array")
	}
	if rf := body.Get("response_format"); optional(rf).Get("type").Is("json_schema") && optional(optional(rf).Get("json_schema")).Get("schema").Truthy() {
		decline("json_schema response_format")
	}
}

// resolveRoute is resolveCompatibleRoute for the hot path: the model's route
// must be the node's Anthropic Messages path.
func (p *prep) resolveRoute() {
	n := p.in.Connection.Node
	if n.APIType == "responses" || (n.APIType != "chat" && strings.Contains(p.in.Provider, "responses")) {
		decline("a Responses node")
	}
	route := n.ModelRoutes[stripThinkingSuffix(p.in.Model)]
	if route != "anthropic" {
		decline("the model is not routed to the Messages API")
	}
	u := appendURLPath(n.BaseURL, "/messages", true)
	if u == "" {
		decline("no base URL")
	}
	// Node hands fetch this string, which parses it and throws on one it can't
	// (or on a blocked port). Only plain http(s)://host[:port]/path?query URLs
	// go native: none without a scheme, on a bad or blocked port, with a dot
	// segment, backslash, bad escape or a character the parser would
	// percent-encode. Request.URL stays the string Node passes; case and a
	// default port are normalized by the sender, as fetch does.
	if _, ok := parseURL(u); !ok {
		decline("a base URL the WHATWG parser would reject or rewrite")
	}
	p.routeURL = u
}

// appendURLPath is provider.js appendUrlPath, with the API-suffix strip.
func appendURLPath(baseURL, path string, strip bool) string {
	raw := baseURL
	q := strings.IndexByte(raw, '?')
	base := raw
	if q >= 0 {
		base = raw[:q]
	}
	base = strings.TrimRight(base, "/")
	if strip {
		for _, s := range []string{"/messages", "/chat/completions", "/responses"} {
			if strings.HasSuffix(base, s) {
				base = base[:len(base)-len(s)]
				break
			}
		}
	}
	if base == "" {
		return ""
	}
	if q >= 0 {
		return base + path + raw[q:]
	}
	return base + path
}

// stream is chatCore's upstream `stream` flag.
func (p *prep) stream(body *Value) bool {
	s := body.Get("stream")
	stream := !(s.Kind() == KindBool && !s.b)
	if detectClientTool(p.in.ClientHeaders, body) == "deepseek-tui" && !(s.Kind() == KindBool && s.b) {
		stream = false
	}
	if clientDemandsJSON(body, p.in.ClientHeaders) {
		stream = false
	}
	if n := p.in.Connection.Node; n.Overrides != nil && n.Overrides.Stream == "never" {
		stream = false
	}
	return stream
}

func clientDemandsJSON(body *Value, headers map[string]string) bool {
	s := body.Get("stream")
	if s.Kind() == KindBool {
		return !s.b
	}
	accept := headers["accept"]
	return strings.Contains(accept, "application/json") && !strings.Contains(accept, "text/event-stream")
}

func asciiLower(what, s string) string {
	for i := 0; i < len(s); i++ {
		if s[i] >= 0x80 {
			decline("non-ASCII " + what + " header")
		}
	}
	return strings.ToLower(s)
}

// detectClientTool is clientDetector.js detectClientTool.
func detectClientTool(h map[string]string, body *Value) string {
	ua := asciiLower("user-agent", h["user-agent"])
	xApp := asciiLower("x-app", h["x-app"])
	intent := asciiLower("openai-intent", h["openai-intent"])
	initiator := h["x-initiator"]
	if initiator == "" {
		initiator = h["X-Initiator"]
	}
	initiator = asciiLower("x-initiator", initiator)
	originator := asciiLower("originator", h["originator"])
	if body.Get("userAgent").Is("antigravity") {
		return "antigravity"
	}
	switch {
	case strings.Contains(ua, "githubcopilotchat") || intent == "conversation-panel" || initiator == "user":
		return "github-copilot"
	case strings.Contains(ua, "claude-cli") || strings.Contains(ua, "claude-code") || xApp == "cli":
		return "claude"
	case strings.Contains(ua, "gemini-cli"):
		return "gemini-cli"
	case strings.Contains(ua, "codex-tui") || strings.Contains(ua, "codex-cli") || strings.Contains(ua, "codex_cli_rs") ||
		strings.Contains(ua, "codex desktop") || strings.HasPrefix(originator, "codex_"):
		return "codex"
	case strings.Contains(ua, "deepseek-tui"):
		return "deepseek-tui"
	}
	return ""
}

// ---- Limit-hold notice (open-sse/utils/limitHoldNotice.js) ---------------------

// joinString is how Array#join writes one element.
func joinString(v *Value) string {
	switch v.Kind() {
	case KindUndefined, KindNull:
		return ""
	case KindBool:
		if v.b {
			return "true"
		}
		return "false"
	case KindNumber:
		return formatNumber(v.f)
	case KindString:
		return v.str
	case KindArray:
		parts := make([]string, len(v.arr))
		for i, it := range v.arr {
			parts[i] = joinString(it)
		}
		return strings.Join(parts, ",")
	}
	// An own toString JSON can only make non-callable: ToString then falls to
	// valueOf, gets the object back, and throws.
	if v.Has("toString") {
		decline("Node would throw converting an object with its own toString")
	}
	return "[object Object]"
}

func limitHoldText(content *Value) string {
	switch content.Kind() {
	case KindString:
		return content.str
	case KindArray:
		parts := make([]string, len(content.arr))
		for i, part := range content.arr {
			switch {
			case part.IsString():
				parts[i] = part.str
			case part.IsObject() || part.IsArray():
				t := part.Get("text")
				if !t.Truthy() {
					t = part.Get("content")
				}
				if t.Truthy() {
					parts[i] = joinString(t)
				}
			}
		}
		return strings.Join(parts, " ")
	case KindObject:
		t := content.Get("text")
		if !t.Truthy() {
			return ""
		}
		if !t.IsString() {
			decline("a message text Node would call includes() on")
		}
		return t.str
	}
	return ""
}

func hasLimitHoldBanner(body *Value) bool {
	for _, key := range []string{"messages", "contents", "input"} {
		bucket := body.Get(key)
		if !bucket.IsArray() {
			continue
		}
		for _, msg := range bucket.Items() {
			if !(msg.IsObject() || msg.IsArray()) {
				continue
			}
			role := msg.Get("role")
			if !role.Is("assistant") && !role.Is("model") {
				continue
			}
			c := msg.Get("content")
			if c.IsNullish() {
				c = msg.Get("parts")
			}
			if c.IsNullish() {
				c = msg.Get("text")
			}
			if strings.Contains(limitHoldText(c), limitHoldSentinel) {
				return true
			}
		}
	}
	return false
}

func injectLimitHoldNotice(body *Value) *Value {
	if !hasLimitHoldBanner(body) {
		return body
	}
	out := body.Spread()
	existing := body.Get("system")
	switch {
	case existing.IsArray():
		items := append(append([]*Value{}, existing.Items()...), obj("type", "text", "text", limitHoldNotice))
		out.Set("system", Array(items...))
	case existing.IsString() && existing.str != "":
		out.Set("system", String(existing.str+"\n\n"+limitHoldNotice))
	default:
		out.Set("system", String(limitHoldNotice))
	}
	return out
}

// ---- Modalities (open-sse/translator/concerns/modality.js) --------------------------

const (
	phVisionCurrent = "[image omitted: model has no vision support]"
	phPDFCurrent    = "[file omitted: model has no document support]"
	phVisionPrev    = "[Previous image omitted from context.]"
	phPDFPrev       = "[Previous file omitted from context.]"
)

func filterMediaBlocks(blocks []*Value, caps Caps, isLast bool) []*Value {
	out := make([]*Value, 0, len(blocks))
	var removed []string
	add := func(c string) {
		for _, r := range removed {
			if r == c {
				return
			}
		}
		removed = append(removed, c)
	}
	for _, b := range blocks {
		t := optional(b).Get("type")
		if t.Is("image") && !caps.Vision {
			add("vision")
			continue
		}
		if t.Is("document") && !caps.PDF {
			add("pdf")
			continue
		}
		out = append(out, b)
	}
	for _, c := range removed {
		text := phVisionPrev
		switch {
		case c == "vision" && isLast:
			text = phVisionCurrent
		case c == "pdf" && isLast:
			text = phPDFCurrent
		case c == "pdf":
			text = phPDFPrev
		}
		out = append(out, obj("type", "text", "text", text))
	}
	return out
}

func stripUnsupportedModalities(body *Value, caps Caps) {
	if caps.Vision && caps.AudioInput && caps.PDF {
		return
	}
	msgs := body.Get("messages")
	if !msgs.IsArray() {
		return
	}
	last := msgs.Len() - 1
	for i, msg := range msgs.Items() {
		content := get(msg, "content")
		if !content.IsArray() {
			continue
		}
		for _, b := range content.Items() {
			if optional(b).Get("type").Is("tool_result") {
				if inner := b.Get("content"); inner.IsArray() {
					b.Set("content", Array(filterMediaBlocks(inner.Items(), caps, i == last)...))
				}
			}
		}
		msg.Set("content", Array(filterMediaBlocks(content.Items(), caps, i == last)...))
	}
}

// ---- Translator-only fields (chatCore) -------------------------------------------

func takeToolMetadata(body *Value) {
	if c := body.Get("_customToolNames"); c.Truthy() && !c.IsArray() && !c.IsString() {
		decline("_customToolNames Node can't make a Set of")
	}
	body.Delete("_customToolNames")
	body.Delete("_toolNamespaces")
}

func stripContinuityFields(body *Value) {
	msgs := body.Get("messages")
	if !msgs.IsArray() {
		return
	}
	for _, m := range msgs.Items() {
		if m.IsObject() {
			m.Delete("encrypted_content")
			m.Delete("reasoning_encrypted_content")
		}
	}
}
