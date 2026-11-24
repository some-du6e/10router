package claudeprep

import (
	"strconv"
	"strings"
)

// Port of translateRequest (open-sse/translator/index.ts) for a Claude body
// to a Claude target, and of prepareClaudeRequest
// (open-sse/translator/formats/claude.js) for a provider that is neither
// claude, anthropic-compatible-* nor deepseek: no thinking-block rewrite, no
// cloaking.

func (p *prep) translate(body *Value) *Value {
	// stripContentTypes: no strip list for a node's models.
	normalizeThinkingConfig(body)
	ensureToolCallIDs(body)
	fixMissingToolResponses(body)
	intent := extractThinking(body)
	declineSessionIDThrows(body)
	applyThinking("claude", p.in.Model, body, p.in.Provider, intent, p.models)
	ensureToolCallIDs(body)
	key := p.in.Connection.AccessToken
	if key == "" {
		key = p.in.Connection.APIKey
	}
	if strings.Contains(key, "sk-ant-oat") {
		body.Set("system", withClaudeCodePrompt(body.Get("system")))
	}
	return p.prepareClaudeRequest(body)
}

// declineSessionIDThrows: translateRequest's captureSessionId (no try/catch
// around it) changes nothing in the body, but throws converting an object
// with its own toString to a string: String(request.sessionId), and the
// assistant text/output it concatenates when no client session id is found.
// Both are checked whether or not Node would reach them (a decline is safe).
func declineSessionIDThrows(body *Value) {
	if sid := optional(body.Get("request")).Get("sessionId"); !sid.IsNullish() && !sid.Is("") {
		joinString(sid)
	}
	// requestMessages: messages if it is an array, else input.
	items := body.Get("messages")
	if !items.IsArray() {
		items = body.Get("input")
	}
	for _, m := range items.Items() {
		if !optional(m).Get("role").Is("assistant") {
			continue
		}
		for _, c := range m.Get("content").Items() {
			v := optional(c).Get("text")
			if !v.Truthy() {
				v = optional(c).Get("output")
			}
			if v.Truthy() {
				joinString(v)
			}
		}
	}
}

// ---- History helpers (provider.js, toolCall.js) -----------------------------------

func isLastMessageFromUser(body *Value) bool {
	msgs := body.Get("messages")
	if !msgs.Truthy() {
		msgs = body.Get("contents")
	}
	if !msgs.Truthy() {
		return true
	}
	if !msgs.IsArray() {
		decline("messages is not an array")
	}
	items := msgs.Items()
	if len(items) == 0 {
		return true
	}
	for i := len(items) - 1; i >= 0; i-- {
		m := items[i]
		if optional(m).Get("role").Is("system") {
			continue
		}
		if !m.Truthy() {
			return true
		}
		return optional(m).Get("role").Is("user")
	}
	return true
}

func normalizeThinkingConfig(body *Value) {
	if !isLastMessageFromUser(body) {
		body.Delete("thinking")
	}
}

func isToolIDChar(c byte) bool {
	return c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '_' || c == '-'
}

// sanitizeChars is s.replace(/[^a-zA-Z0-9_-]/g, ""): every other UTF-16
// unit goes, so every byte outside the set does too.
func sanitizeChars(s string) string {
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		if isToolIDChar(s[i]) {
			b.WriteByte(s[i])
		}
	}
	return b.String()
}

// idPasses is TOOL_ID_PATTERN.test(v), which reads String(v).
func idPasses(v *Value) bool {
	var s string
	switch v.Kind() {
	case KindString:
		s = v.str
	case KindNumber:
		s = formatNumber(v.f)
	case KindBool:
		s = joinString(v)
	case KindNull:
		s = "null"
	case KindUndefined:
		s = "undefined"
	default:
		decline("a tool id that is an object or array")
	}
	if s == "" {
		return false
	}
	for i := 0; i < len(s); i++ {
		if !isToolIDChar(s[i]) {
			return false
		}
	}
	return true
}

func sanitizeToolID(v *Value) string {
	if !v.IsString() || v.str == "" {
		return ""
	}
	return sanitizeChars(v.str)
}

func generateToolCallID(msgIndex, tcIndex int, name *Value) string {
	n := ""
	if name.Truthy() {
		if !name.IsString() {
			decline("a tool name Node would call replace() on")
		}
		n = "_" + sanitizeChars(name.str)
	}
	return "call_msg" + strconv.Itoa(msgIndex) + "_tc" + strconv.Itoa(tcIndex) + n
}

func ensureToolCallIDs(body *Value) {
	msgs := body.Get("messages")
	if !msgs.Truthy() || !msgs.IsArray() {
		return
	}
	for i, msg := range msgs.Items() {
		role := get(msg, "role")
		if role.Is("assistant") {
			if tcs := msg.Get("tool_calls"); tcs.Truthy() && tcs.IsArray() {
				for j, tc := range tcs.Items() {
					if tc.IsArray() {
						// Node sets id and type on the array: invisible to JSON.
						continue
					}
					if !tc.IsNullish() && !tc.IsObject() {
						decline("a tool call that isn't an object")
					}
					id := get(tc, "id")
					if !id.Truthy() || !idPasses(id) {
						s := sanitizeToolID(id)
						if s == "" {
							s = generateToolCallID(i, j, optional(tc.Get("function")).Get("name"))
						}
						tc.Set("id", String(s))
					}
					if !tc.Get("type").Truthy() {
						tc.Set("type", String("function"))
					}
					if fn := tc.Get("function"); optional(fn).Get("arguments").Truthy() && !fn.Get("arguments").IsString() {
						nf := fn.Spread()
						nf.Set("arguments", String(string(Marshal(fn.Get("arguments")))))
						tc.Set("function", nf)
					}
				}
			}
		}
		if role.Is("tool") {
			if id := msg.Get("tool_call_id"); id.Truthy() && !idPasses(id) {
				s := sanitizeToolID(id)
				if s == "" {
					s = generateToolCallID(i, 0, nil)
				}
				msg.Set("tool_call_id", String(s))
			}
		}
		content := msg.Get("content")
		if !content.IsArray() {
			continue
		}
		for k, b := range content.Items() {
			t := get(b, "type")
			if t.Is("tool_use") {
				if id := b.Get("id"); !id.Truthy() || !idPasses(id) {
					s := sanitizeToolID(id)
					if s == "" {
						s = generateToolCallID(i, k, b.Get("name"))
					}
					b.Set("id", String(s))
				}
			}
			if t.Is("tool_result") {
				if id := b.Get("tool_use_id"); id.Truthy() && !idPasses(id) {
					s := sanitizeToolID(id)
					if s == "" {
						s = generateToolCallID(i, k, nil)
					}
					b.Set("tool_use_id", String(s))
				}
			}
		}
	}
}

func toolCallIDs(msg *Value) []*Value {
	if !get(msg, "role").Is("assistant") {
		return nil
	}
	var ids []*Value
	if tcs := msg.Get("tool_calls"); tcs.Truthy() && tcs.IsArray() {
		for _, tc := range tcs.Items() {
			if id := get(tc, "id"); id.Truthy() {
				ids = append(ids, id)
			}
		}
	}
	if c := msg.Get("content"); c.IsArray() {
		for _, b := range c.Items() {
			if get(b, "type").Is("tool_use") {
				if id := b.Get("id"); id.Truthy() {
					ids = append(ids, id)
				}
			}
		}
	}
	return ids
}

// sameValueZero is Array#includes's comparison.
func sameValueZero(a, b *Value) bool {
	if a.Kind() != b.Kind() {
		return false
	}
	switch a.Kind() {
	case KindUndefined, KindNull:
		return true
	case KindBool:
		return a.b == b.b
	case KindNumber:
		return a.f == b.f || (a.f != a.f && b.f != b.f)
	case KindString:
		return a.str == b.str
	}
	return a == b
}

func includesValue(list []*Value, v *Value) bool {
	for _, x := range list {
		if sameValueZero(x, v) {
			return true
		}
	}
	return false
}

func hasToolResults(msg *Value, ids []*Value) bool {
	if !msg.Truthy() || len(ids) == 0 {
		return false
	}
	role := msg.Get("role")
	if role.Is("tool") {
		if id := msg.Get("tool_call_id"); id.Truthy() {
			return includesValue(ids, id)
		}
	}
	if role.Is("user") {
		if c := msg.Get("content"); c.IsArray() {
			// ids.includes per block is |blocks|×|ids| in Node; with string
			// ids (the usual case) a set gives the same answer in linear time.
			var set map[string]bool
			if len(ids) > 8 {
				set = make(map[string]bool, len(ids))
				for _, id := range ids {
					if !id.IsString() {
						set = nil
						break
					}
					set[id.str] = true
				}
			}
			for _, b := range c.Items() {
				if !get(b, "type").Is("tool_result") {
					continue
				}
				if id := b.Get("tool_use_id"); set != nil {
					if id.IsString() && set[id.str] {
						return true
					}
				} else if includesValue(ids, id) {
					return true
				}
			}
		}
	}
	return false
}

func fixMissingToolResponses(body *Value) {
	msgs := body.Get("messages")
	if !msgs.Truthy() || !msgs.IsArray() {
		return
	}
	items := msgs.Items()
	out := make([]*Value, 0, len(items))
	at := func(j int) *Value {
		if j < len(items) {
			return items[j]
		}
		return nil
	}
	// nextNonSystem[i]: the first index after i whose role isn't "system"
	// (Node rescans for each message; the same answer in one pass).
	nextNonSystem := make([]int, len(items)+1)
	nextNonSystem[len(items)] = len(items)
	for i := len(items) - 1; i >= 0; i-- {
		if i+1 < len(items) && optional(items[i+1]).Get("role").Is("system") {
			nextNonSystem[i] = nextNonSystem[i+1]
		} else {
			nextNonSystem[i] = i + 1
		}
	}
	for i, msg := range items {
		j := nextNonSystem[i]
		next := at(j)
		out = append(out, msg)
		ids := toolCallIDs(msg)
		if len(ids) == 0 {
			continue
		}
		if (next.Truthy() || j > i+1) && !(next.Truthy() && hasToolResults(next, ids)) {
			for _, id := range ids {
				out = append(out, obj("role", "tool", "tool_call_id", id, "content", ""))
			}
		}
	}
	body.Set("messages", Array(out...))
}

func withClaudeCodePrompt(system *Value) *Value {
	var blocks []*Value
	switch {
	case system.IsArray():
		blocks = system.Items()
	case system.IsString():
		blocks = []*Value{obj("type", "text", "text", system)}
	}
	kept := make([]*Value, 0, len(blocks)+1)
	for _, b := range blocks {
		if !b.Truthy() {
			continue
		}
		if !optional(b).Get("type").Is("text") || trimmedText(b) != "" {
			kept = append(kept, b)
		}
	}
	for _, b := range kept {
		// b?.text?.trim() === CLAUDE_SYSTEM_PROMPT (undefined text reads "" here, which never matches).
		if trimmedText(b) == claudeSystemPrompt {
			return Array(kept...)
		}
	}
	return Array(append([]*Value{obj("type", "text", "text", claudeSystemPrompt)}, kept...)...)
}

// trimmedText is block.text?.trim() as a string ("" for undefined).
func trimmedText(b *Value) string {
	t := optional(b).Get("text")
	if t.IsNullish() {
		return ""
	}
	if !t.IsString() {
		decline("a text that isn't a string, where Node calls trim()")
	}
	return jsTrim(t.str)
}

// ---- prepareClaudeRequest -----------------------------------------------------------

func supportsAssistantPrefill(model string) bool {
	base := lastSegment(model)
	// /^claude-opus-5(?:$|-)/i
	if len(base) < len("claude-opus-5") || !strings.EqualFold(base[:len("claude-opus-5")], "claude-opus-5") {
		return true
	}
	rest := base[len("claude-opus-5"):]
	return !(rest == "" || rest[0] == '-')
}

func hasValidContent(msg *Value) bool {
	c := msg.Get("content")
	if c.IsString() && jsTrim(c.str) != "" {
		return true
	}
	if c.IsArray() {
		for _, b := range c.Items() {
			t := get(b, "type")
			if t.Is("text") && trimmedText(b) != "" {
				return true
			}
			if t.Is("tool_use") || t.Is("tool_result") || t.Is("image") || t.Is("document") {
				return true
			}
		}
	}
	return false
}

func isThinkingBlock(b *Value) bool {
	t := optional(b).Get("type")
	return t.Is("thinking") || t.Is("redacted_thinking")
}

func asContentArray(msg *Value) []*Value {
	c := msg.Get("content")
	if c.IsArray() {
		return c.Items()
	}
	return []*Value{obj("type", "text", "text", orUndefined(c))}
}

func orUndefined(v *Value) *Value {
	if v == nil {
		return Undefined()
	}
	return v
}

// strictEquals is === between two values.
func strictEquals(a, b *Value) bool {
	if a.Kind() != b.Kind() {
		return false
	}
	switch a.Kind() {
	case KindNumber:
		return a.f == b.f
	case KindArray, KindObject:
		return a == b
	}
	return sameValueZero(a, b)
}

func fixToolUseOrdering(msgs []*Value) []*Value {
	if len(msgs) <= 1 {
		return msgs
	}
	for _, msg := range msgs {
		if !msg.Get("role").Is("assistant") || !msg.Get("content").IsArray() {
			continue
		}
		content := msg.Get("content").Items()
		has := false
		for _, b := range content {
			if b.Get("type").Is("tool_use") {
				has = true
				break
			}
		}
		if !has {
			continue
		}
		kept := make([]*Value, 0, len(content))
		found := false
		for _, b := range content {
			switch {
			case b.Get("type").Is("tool_use"):
				found = true
				kept = append(kept, b)
			case isThinkingBlock(b):
				kept = append(kept, b)
			case !found:
				kept = append(kept, b)
			}
		}
		msg.Set("content", Array(kept...))
	}
	// Node rebuilds the merged content on every merge: [...results of both,
	// ...the rest of both]. After the first merge the content is already
	// results-then-rest, so keeping the two runs and joining them once per
	// merged message gives the same array in linear time.
	merged := make([]*Value, 0, len(msgs))
	var results, rest []*Value
	open := false // the last merged message has had a merge
	flush := func() {
		if open {
			merged[len(merged)-1].Set("content", Array(append(results, rest...)...))
		}
		open, results, rest = false, nil, nil
	}
	split := func(list []*Value) {
		for _, b := range list {
			if b.Get("type").Is("tool_result") {
				results = append(results, b)
			} else {
				rest = append(rest, b)
			}
		}
	}
	for _, msg := range msgs {
		if n := len(merged); n > 0 && strictEquals(merged[n-1].Get("role"), msg.Get("role")) {
			if !open {
				split(merged[n-1].Get("content").Items())
				open = true
			}
			split(asContentArray(msg))
			continue
		}
		flush()
		content := asContentArray(msg)
		merged = append(merged, obj("role", orUndefined(msg.Get("role")), "content", Array(append([]*Value{}, content...)...)))
	}
	flush()
	return merged
}

func continuationContent(assistant *Value) *Value {
	var uses []*Value
	for _, b := range optional(assistant).Get("content").Items() {
		if optional(b).Get("type").Is("tool_use") && b.Get("id").Truthy() {
			uses = append(uses, b)
		}
	}
	if len(uses) == 0 {
		return Array(obj("type", "text", "text", prefillContinuationText))
	}
	out := make([]*Value, len(uses))
	for i, b := range uses {
		out[i] = obj("type", "tool_result", "tool_use_id", b.Get("id"), "content", interruptedToolResultText, "is_error", true)
	}
	return Array(out...)
}

func repairUnsupportedAssistantPrefill(msgs []*Value, model string) []*Value {
	if supportsAssistantPrefill(model) || len(msgs) == 0 {
		return msgs
	}
	last := msgs[len(msgs)-1]
	if !optional(last).Get("role").Is("assistant") {
		return msgs
	}
	return append(append([]*Value{}, msgs...), obj("role", "user", "content", continuationContent(last)))
}

func cacheControl(ttl1h bool) *Value {
	if ttl1h {
		return obj("type", "ephemeral", "ttl", "1h")
	}
	return obj("type", "ephemeral")
}

// bodyModel is body.model where Node passes it on as a model id.
func bodyModel(body *Value) string {
	m := body.Get("model")
	if !m.IsString() {
		decline("body.model is not a string")
	}
	checkID("model", m.str)
	return m.str
}

func (p *prep) prepareClaudeRequest(body *Value) *Value {
	provider := p.in.Provider

	if mt := body.Get("max_tokens"); mt.Truthy() {
		if !mt.IsNumber() {
			decline("max_tokens is not a number")
		}
		ceiling := p.models.Capabilities(provider, bodyModel(body)).MaxOutput
		if ceiling == 0 || ceiling != ceiling {
			ceiling = defaultMaxTokens
		}
		if mt.f > ceiling {
			body.Set("max_tokens", Number(ceiling))
		}
		th := body.Get("thinking")
		if optional(th).Get("type").Is("enabled") {
			if bt := th.Get("budget_tokens"); bt.Truthy() {
				if !bt.IsNumber() {
					decline("budget_tokens is not a number")
				}
				if bt.f >= body.Get("max_tokens").f {
					mx := bt.f + 1024
					if ceiling < mx {
						mx = ceiling
					}
					body.Set("max_tokens", Number(mx))
					if bt.f >= mx {
						nb := mx - 1024
						if nb < 1024 {
							nb = 1024
						}
						th.Set("budget_tokens", Number(nb))
					}
				}
			}
		}
	}

	// 1. System: blank text blocks go, then one 1h breakpoint on the last block.
	if s := body.Get("system"); s.IsString() && jsTrim(s.str) == "" {
		body.Delete("system")
	}
	if s := body.Get("system"); s.IsArray() {
		kept := make([]*Value, 0, s.Len())
		for _, b := range s.Items() {
			if !b.Truthy() {
				continue
			}
			if !optional(b).Get("type").Is("text") || trimmedText(b) != "" {
				kept = append(kept, b)
			}
		}
		if len(kept) == 0 {
			body.Delete("system")
		} else {
			out := make([]*Value, len(kept))
			for i, b := range kept {
				if !b.IsObject() {
					decline("a system block that isn't an object")
				}
				rest := b.Without("cache_control")
				if i == len(kept)-1 {
					rest.Set("cache_control", cacheControl(true))
				}
				out[i] = rest
			}
			body.Set("system", Array(out...))
		}
	}

	// 2. Messages.
	if msgs := body.Get("messages"); msgs.Truthy() && msgs.IsArray() {
		model := bodyModel(body)
		items := msgs.Items()
		filtered := make([]*Value, 0, len(items))
		for i, msg := range items {
			if c := get(msg, "content"); c.IsArray() {
				for _, b := range c.Items() {
					if b.IsNullish() {
						decline("a content block that isn't an object")
					}
					b.Delete("cache_control")
				}
			}
			prefill := i == len(items)-1 && msg.Get("role").Is("assistant") && supportsAssistantPrefill(model)
			if prefill || hasValidContent(msg) {
				filtered = append(filtered, msg)
			}
		}
		filtered = fixToolUseOrdering(filtered)
		filtered = repairUnsupportedAssistantPrefill(filtered, model)
		body.Set("messages", Array(filtered...))

		done := false
		for i := len(filtered) - 1; i >= 0 && !done; i-- {
			msg := filtered[i]
			if !msg.Get("role").Is("assistant") || !msg.Get("content").IsArray() || msg.Get("content").Len() == 0 {
				continue
			}
			content := msg.Get("content").Items()
			for j := len(content) - 1; j >= 0; j-- {
				b := content[j]
				if !isThinkingBlock(b) {
					if !b.IsObject() {
						decline("Node would throw setting cache_control on a non-object block")
					}
					b.Set("cache_control", cacheControl(false))
					break
				}
			}
			done = true
		}
	}

	// 3. Tools: built-ins and schema-less custom tools go, OpenAI-shaped ones
	// fold, input schemas get an object type, then one 1h breakpoint.
	if tools := body.Get("tools"); tools.Truthy() && tools.IsArray() {
		list := normalizeToolSchemas(toProviderClaudeTools(tools.Items()))
		last := lastCacheableToolIndex(list)
		out := make([]*Value, len(list))
		for i, t := range list {
			rest := t.Without("cache_control")
			if i == last {
				rest.Set("cache_control", cacheControl(true))
			}
			out[i] = rest
		}
		body.Set("tools", Array(out...))
		if len(out) == 0 {
			body.Delete("tools")
			body.Delete("tool_choice")
		}
	}

	relaxForcedToolChoice(body, provider, false, p.models)
	return body
}

func toProviderClaudeTools(tools []*Value) []*Value {
	out := make([]*Value, 0, len(tools))
	for _, t := range tools {
		if t.IsNullish() {
			decline("a tool that is null")
		}
		if !t.IsObject() {
			decline("a tool that isn't an object")
		}
		typ := t.Get("type")
		keep := !typ.Truthy() || typ.Is("function") ||
			(typ.Is("custom") && t.Get("name").IsString() && t.Get("input_schema").Truthy())
		if !keep {
			continue
		}
		if fn := t.Get("function"); fn.Truthy() {
			f := optional(fn)
			out = append(out, obj(
				"name", orUndefined(f.Get("name")),
				"description", orUndefined(f.Get("description")),
				"input_schema", orUndefined(f.Get("parameters")),
			))
			continue
		}
		out = append(out, t.Without("type"))
	}
	return out
}

func lastCacheableToolIndex(tools []*Value) int {
	for i := len(tools) - 1; i >= 0; i-- {
		if d := optional(tools[i]).Get("defer_loading"); !(d.Kind() == KindBool && d.b) {
			return i
		}
	}
	return -1
}

func hasCombinator(s *Value) bool { return s.Has("allOf") || s.Has("anyOf") || s.Has("oneOf") }

func permissiveSchema() *Value {
	return obj("type", "object", "properties", Object(), "additionalProperties", true)
}

// normalizeInputSchema is normalizeClaudeInputSchema; flattening a top-level
// allOf/anyOf/oneOf or $ref goes to Node.
func normalizeInputSchema(s *Value) *Value {
	if !s.IsObject() {
		return permissiveSchema()
	}
	if hasCombinator(s) || s.Get("$ref").IsString() {
		decline("tool input_schema needs flattening")
	}
	typ := s.Get("type")
	if typ.IsUndefined() && s.Get("properties").IsObject() {
		out := s.Spread()
		out.Set("type", String("object"))
		return out
	}
	if typ.IsArray() {
		for _, t := range typ.Items() {
			if t.Is("object") {
				out := s.Spread()
				out.Set("type", String("object"))
				return out
			}
		}
	}
	return s
}

func normalizeToolSchemas(tools []*Value) []*Value {
	out := make([]*Value, len(tools))
	for i, t := range tools {
		out[i] = t
		if !t.IsObject() || t.Get("input_schema").IsUndefined() {
			continue
		}
		s := t.Get("input_schema")
		if ns := normalizeInputSchema(s); ns != s {
			nt := t.Spread()
			nt.Set("input_schema", ns)
			out[i] = nt
		}
	}
	return out
}

// relaxForcedToolChoice is relaxForcedToolChoiceForThinking.
func relaxForcedToolChoice(body *Value, provider string, thinkingIsFinal bool, models Models) {
	choice := body.Get("tool_choice")
	ct := optional(choice).Get("type")
	if !ct.Is("any") && !ct.Is("tool") {
		return
	}
	// getCapabilitiesForModel(provider, body.model): a falsy model gets the
	// defaults (an override's drop list can remove it); another non-string
	// throws in Node.
	var caps Caps
	if m := body.Get("model"); !m.Truthy() {
		caps = models.Capabilities(provider, "")
	} else {
		caps = models.Capabilities(provider, bodyModel(body))
	}
	const none, always, withThinking = 0, 1, 2
	rule := none
	switch {
	case !strings.HasPrefix(caps.ThinkingFormat, "claude"):
	case !caps.ForcedToolChoice:
		rule = always
	case !caps.ForcedToolChoiceWithThinking || caps.ThinkingFormat == "claude-budget":
		rule = withThinking
	}
	tt := optional(body.Get("thinking")).Get("type")
	reject := rule == always || (thinkingIsFinal && rule == withThinking && (tt.Is("enabled") || tt.Is("adaptive")))
	if !reject {
		return
	}
	nc := obj("type", "auto")
	if d := choice.Get("disable_parallel_tool_use"); !d.IsUndefined() {
		nc.Set("disable_parallel_tool_use", d)
	}
	body.Set("tool_choice", nc)
}

// ---- Tool lists (toolDeduper.js, toolCall.js) -------------------------------------------

func toolName(t *Value) *Value {
	n := optional(t).Get("name")
	if !n.Truthy() {
		n = optional(optional(t).Get("function")).Get("name")
	}
	if !n.Truthy() {
		return String("")
	}
	if !n.IsString() {
		decline("a tool name that isn't a string")
	}
	return n
}

type dedupeRule struct {
	triggers []string // "^" prefix marks a prefix match (a /^…/ rule)
	strip    []string
}

var dedupeRules = []dedupeRule{
	{[]string{"mcp__exa__web_search_exa", "mcp__exa__web_fetch_exa"}, []string{"WebSearch", "WebFetch", "mcp__workspace__web_fetch"}},
	{[]string{"mcp__tavily__tavily_search", "mcp__tavily__tavily_extract"}, []string{"WebSearch", "WebFetch", "mcp__workspace__web_fetch"}},
	{[]string{"^mcp__browsermcp__"}, []string{"^mcp__Claude_in_Chrome__"}},
}

func ruleMatches(name, pattern string) bool {
	if strings.HasPrefix(pattern, "^") {
		return strings.HasPrefix(name, pattern[1:])
	}
	return name == pattern
}

func dedupeTools(tools []*Value) ([]*Value, bool) {
	if len(tools) == 0 {
		return tools, false
	}
	names := make([]string, len(tools))
	for i, t := range tools {
		names[i] = toolName(t).str
	}
	strip := map[string]bool{}
	for _, r := range dedupeRules {
		triggered := false
		for _, n := range names {
			for _, p := range r.triggers {
				if ruleMatches(n, p) {
					triggered = true
				}
			}
		}
		if !triggered {
			continue
		}
		for _, n := range names {
			for _, p := range r.strip {
				if ruleMatches(n, p) {
					strip[n] = true
				}
			}
		}
	}
	if len(strip) == 0 {
		return tools, false
	}
	out := make([]*Value, 0, len(tools))
	for i, t := range tools {
		if !strip[names[i]] {
			out = append(out, t)
		}
	}
	return out, true
}

func defaultClaudeToolType(tools *Value) *Value {
	items := tools.Items()
	out := make([]*Value, len(items))
	for i, t := range items {
		if optional(t).Get("type").Truthy() {
			out[i] = t
			continue
		}
		if !t.IsObject() {
			decline("a tool that isn't an object")
		}
		nt := t.Spread()
		nt.Set("type", String("custom"))
		out[i] = nt
	}
	return Array(out...)
}
