package claudeprep

import (
	"math"
	"regexp"
	"strings"
)

// Port of open-sse/translator/concerns/thinkingUnified.js and thinking.js.

// thinkingCfg is the unified intent: mode none | auto | level | budget.
type thinkingCfg struct {
	mode   string
	level  string
	budget float64
}

var suffixRe = regexp.MustCompile(`^(.*)\(([^()]+)\)\s*$`)

// The model ids that reach these are printable ASCII (Prepare checks), where
// \s and String#trim agree with Go's handling here.
func stripThinkingSuffix(model string) string {
	m := suffixRe.FindStringSubmatch(model)
	if m == nil {
		return model
	}
	return jsTrim(m[1])
}

var digitsRe = regexp.MustCompile(`^\d+$`)

func parseSuffix(model string) (string, *thinkingCfg) {
	m := suffixRe.FindStringSubmatch(model)
	if m == nil {
		return model, nil
	}
	clean := jsTrim(m[1])
	raw := levelName(jsTrim(m[2]))
	switch {
	case raw == "none" || raw == "off":
		return clean, &thinkingCfg{mode: "none"}
	case raw == "auto":
		return clean, &thinkingCfg{mode: "auto"}
	case raw == "ultra":
		return clean, &thinkingCfg{mode: "level", level: raw}
	case digitsRe.MatchString(raw):
		return clean, &thinkingCfg{mode: "budget", budget: jsStringToNumber(raw)}
	}
	if _, ok := tbl.LevelToBudget[raw]; ok {
		return clean, &thinkingCfg{mode: "level", level: raw}
	}
	return clean, nil
}

// jsLower is String#toLowerCase for the effort strings it meets; anything
// outside ASCII goes back to Node.
func jsLower(s string) string {
	for i := 0; i < len(s); i++ {
		if s[i] >= 0x80 {
			decline("a non-ASCII effort or level")
		}
	}
	return strings.ToLower(s)
}

// toNumber is Number(v) for the shapes thinking intent reads.
func toNumber(v *Value) float64 {
	switch v.Kind() {
	case KindUndefined:
		return math.NaN()
	case KindNull:
		return 0
	case KindBool:
		if v.b {
			return 1
		}
		return 0
	case KindNumber:
		return v.f
	case KindString:
		return jsStringToNumber(v.str)
	}
	decline("Number() of an object or array")
	return 0
}

func finite(f float64) bool { return !math.IsNaN(f) && !math.IsInf(f, 0) }

// levelName is a client- or config-given level after toLowerCase. Node looks
// levels up in plain objects, where "constructor" or "__proto__" finds an
// Object.prototype member; those go to Node.
func levelName(s string) string {
	s = jsLower(s)
	if isProtoName(s) {
		decline("a thinking level that names an Object.prototype member")
	}
	return s
}

func effortCfg(e string) *thinkingCfg {
	e = levelName(e)
	if e == "none" || e == "off" {
		return &thinkingCfg{mode: "none"}
	}
	if e == "auto" {
		return &thinkingCfg{mode: "auto"}
	}
	return &thinkingCfg{mode: "level", level: e}
}

// extractThinking reads the intent from a body, any shape; nil when none.
func extractThinking(body *Value) *thinkingCfg {
	if !body.IsObject() {
		return nil
	}
	if oc := optional(body.Get("output_config")).Get("effort"); oc.IsString() && oc.str != "" {
		return effortCfg(oc.str)
	}
	effort := body.Get("reasoning_effort")
	if effort.IsNullish() {
		if r := body.Get("reasoning"); r.Kind() == KindObject || r.Kind() == KindArray || r.Kind() == KindNull {
			effort = optional(r).Get("effort")
		} else {
			effort = nil
		}
	}
	if effort.IsString() && effort.str != "" {
		return effortCfg(effort.str)
	}
	if t := body.Get("thinking"); t.IsObject() || t.IsArray() {
		typ := t.Get("type")
		if typ.Is("disabled") {
			return &thinkingCfg{mode: "none"}
		}
		if typ.Is("adaptive") || typ.Is("enabled") {
			b := toNumber(t.Get("budget_tokens"))
			if finite(b) && b > 0 {
				return &thinkingCfg{mode: "budget", budget: b}
			}
			return &thinkingCfg{mode: "auto"}
		}
	}
	tc := body.Get("thinkingConfig")
	if !tc.Truthy() {
		tc = optional(body.Get("generationConfig")).Get("thinkingConfig")
	}
	if !tc.Truthy() {
		tc = optional(optional(body.Get("request")).Get("generationConfig")).Get("thinkingConfig")
	}
	if tc.IsObject() || tc.IsArray() {
		if lvl := tc.Get("thinkingLevel"); lvl.IsString() {
			return &thinkingCfg{mode: "level", level: levelName(lvl.str)}
		}
		tb := toNumber(tc.Get("thinkingBudget"))
		if finite(tb) {
			if tb == 0 {
				return &thinkingCfg{mode: "none"}
			}
			if tb < 0 {
				return &thinkingCfg{mode: "auto"}
			}
			return &thinkingCfg{mode: "budget", budget: tb}
		}
	}
	if et := body.Get("enable_thinking"); et.Kind() == KindBool {
		if !et.b {
			return &thinkingCfg{mode: "none"}
		}
		tb := toNumber(body.Get("thinking_budget"))
		if finite(tb) && tb > 0 {
			return &thinkingCfg{mode: "budget", budget: tb}
		}
		return &thinkingCfg{mode: "auto"}
	}
	return nil
}

// optional is `v?.`: property reads on a value that may be nullish. A
// property read on any other primitive is undefined too, so only objects
// matter; arrays have no named members in a parsed body.
func optional(v *Value) *Value {
	if v.IsObject() {
		return v
	}
	return nil
}

var nativeOnly = map[string]bool{"gemini-level": true, "gemini-budget": true, "claude-budget": true, "claude-adaptive": true, "kiro": true}

var formatToNative = map[string]string{
	"openai": "openai", "openai-responses": "openai", "openai-response": "openai", "codex": "openai",
	"claude": "claude-budget", "gemini": "gemini-budget", "gemini-cli": "gemini-budget", "vertex": "gemini-budget",
	"antigravity": "gemini-budget", "kiro": "kiro",
}

func resolveThinkingFormat(targetFormat string, caps Caps) string {
	// PROVIDERS[provider].thinkingFormat: none for openai-compatible-* nodes.
	openaiWire := targetFormat == "openai" || targetFormat == "openai-responses"
	if caps.ThinkingFormat != "" && !(openaiWire && nativeOnly[caps.ThinkingFormat]) {
		return caps.ThinkingFormat
	}
	if f, ok := formatToNative[targetFormat]; ok {
		return f
	}
	return "openai"
}

func effortToBudget(level string) (float64, bool) {
	if level == "" {
		return 0, false
	}
	b, ok := tbl.LevelToBudget[jsLower(level)]
	return b, ok
}

// toBudget: ok false is undefined; -1 is auto.
func toBudget(cfg *thinkingCfg, r *ThinkingRange) (float64, bool) {
	var budget float64
	switch cfg.mode {
	case "budget":
		budget = cfg.budget
	case "level":
		b, ok := effortToBudget(cfg.level)
		if !ok {
			return 0, false
		}
		budget = b
	case "auto":
		return -1, true
	default:
		return 0, false
	}
	if !finite(budget) {
		return 0, false
	}
	if r != nil {
		if r.Min != nil && budget < *r.Min {
			budget = *r.Min
		}
		if r.Max != nil && budget > *r.Max {
			budget = *r.Max
		}
	}
	return budget, true
}

func budgetToLevel(b float64) string {
	if b == 0 || math.IsNaN(b) || b <= 0 {
		return ""
	}
	switch {
	case b <= 768:
		return "minimal"
	case b <= 4096:
		return "low"
	case b <= 16384:
		return "medium"
	case b <= 28672:
		return "high"
	}
	return "xhigh"
}

// toLevel: "" is null.
func toLevel(cfg *thinkingCfg) string {
	switch cfg.mode {
	case "level":
		return cfg.level
	case "budget":
		if l := budgetToLevel(cfg.budget); l != "" {
			return l
		}
		return "medium"
	case "auto":
		return "auto"
	}
	return ""
}

func contains(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}

func normalizeOpenAILevel(level string, supported []string) string {
	if level != "max" && level != "ultra" {
		return level
	}
	if contains(supported, level) {
		return level
	}
	if level == "ultra" && contains(supported, "max") {
		return "max"
	}
	return "xhigh"
}

func effortToThinkingLevel(e string) string {
	// Trimmed here (not where the level was read), so " constructor" only
	// becomes a prototype name now.
	e = levelName(jsTrim(e))
	if e == "none" || e == "off" {
		return "minimal"
	}
	if e == "xhigh" || e == "max" {
		return "high"
	}
	return e
}

func toGeminiThinkingLevel(cfg *thinkingCfg) string {
	raw := "high"
	if cfg.mode != "auto" {
		if l := toLevel(cfg); l != "" {
			raw = l
		}
	}
	return effortToThinkingLevel(raw)
}

func toKimiReasoningEffort(cfg *thinkingCfg) string {
	level := toLevel(cfg)
	switch level {
	case "auto":
		return "high"
	case "minimal":
		return "low"
	case "xhigh":
		return "max"
	case "low", "medium", "high", "max":
		return level
	}
	return ""
}

var geminiLevelOutputFloor = map[string]float64{"minimal": 4096, "low": 8192, "medium": 16384, "high": 65535}

func geminiBudgetOutputFloor(b float64) float64 {
	switch {
	case b == -1 || !finite(b):
		return 32768
	case b <= 1024:
		return 8192
	case b <= 8192:
		return 16384
	case b <= 24576:
		return 32768
	}
	return 65535
}

func geminiGenerationConfig(body *Value) *Value {
	if r := body.Get("request"); r.IsObject() || r.IsArray() {
		if r.IsArray() {
			decline("a request envelope that is an array")
		}
		gc := r.Get("generationConfig")
		if !(gc.IsObject() || gc.IsArray()) || !gc.Truthy() {
			gc = Object()
			r.Set("generationConfig", gc)
		}
		if gc.IsArray() {
			decline("generationConfig is an array")
		}
		return gc
	}
	gc := body.Get("generationConfig")
	if !(gc.IsObject() || gc.IsArray()) {
		gc = Object()
		body.Set("generationConfig", gc)
	}
	if gc.IsArray() {
		decline("generationConfig is an array")
	}
	return gc
}

func ensureGeminiOutputFloor(body *Value, floor float64, caps Caps) {
	target := math.Min(floor, caps.MaxOutput)
	gc := geminiGenerationConfig(body)
	cur := toNumber(gc.Get("maxOutputTokens"))
	if !finite(cur) || cur < target {
		gc.Set("maxOutputTokens", Number(target))
	}
}

func stripAllThinking(body *Value) {
	for _, k := range []string{"thinking", "reasoning_effort", "reasoning", "thinkingConfig", "enable_thinking", "thinking_budget", "output_config"} {
		body.Delete(k)
	}
	if gc := body.Get("generationConfig"); gc.Truthy() {
		if gc.IsObject() {
			gc.Delete("thinkingConfig")
		}
	}
	if gc := optional(body.Get("request")).Get("generationConfig"); gc.Truthy() && gc.IsObject() {
		gc.Delete("thinkingConfig")
	}
}

func obj(kv ...any) *Value {
	o := Object()
	for i := 0; i < len(kv); i += 2 {
		var v *Value
		switch x := kv[i+1].(type) {
		case *Value:
			v = x
		case string:
			v = String(x)
		case float64:
			v = Number(x)
		case int:
			v = Number(float64(x))
		case bool:
			v = Bool(x)
		}
		o.Set(kv[i].(string), v)
	}
	return o
}

func applyThinkingFormat(fmt string, body *Value, cfg *thinkingCfg, caps Caps, supported []string) {
	none := cfg.mode == "none"
	canDisable := caps.ThinkingCanDisable
	eff := cfg
	if none && !canDisable {
		eff = &thinkingCfg{mode: "level", level: "minimal"}
	}
	switch fmt {
	case "openai":
		if none && canDisable {
			body.Set("reasoning_effort", String("none"))
			return
		}
		if none && len(supported) > 0 {
			for _, l := range supported {
				if l != "none" {
					body.Set("reasoning_effort", String(l))
					return
				}
			}
			body.Set("reasoning_effort", Undefined())
			return
		}
		if l := toLevel(eff); l != "" {
			body.Set("reasoning_effort", String(normalizeOpenAILevel(l, supported)))
		}
	case "claude-adaptive":
		if none && canDisable {
			body.Set("thinking", obj("type", "disabled"))
			return
		}
		if canDisable {
			body.Set("thinking", obj("type", "adaptive"))
		} else {
			body.Delete("thinking")
		}
		level := toLevel(eff)
		effort := level
		switch {
		case none || level == "minimal":
			effort = "low"
		case level == "xhigh":
			effort = "high"
		}
		// toLevel's null is unreachable here (mode none returned above or
		// became minimal), so "" is a real empty level and goes out as "".
		body.Set("output_config", obj("effort", effort))
	case "claude-budget", "hunyuan":
		if none && canDisable {
			body.Set("thinking", obj("type", "disabled"))
			return
		}
		b, ok := toBudget(eff, caps.ThinkingRange)
		if ok && b == -1 {
			body.Set("thinking", obj("type", "enabled"))
			return
		}
		if !ok || b == 0 {
			b = 8192
		}
		body.Set("thinking", obj("type", "enabled", "budget_tokens", b))
	case "gemini-level":
		level := "minimal"
		if !none {
			level = toGeminiThinkingLevel(eff)
		}
		geminiGenerationConfig(body).Set("thinkingConfig", obj("thinkingLevel", level, "includeThoughts", level != "minimal"))
		floor, ok := geminiLevelOutputFloor[level]
		if !ok {
			floor = geminiLevelOutputFloor["high"]
		}
		ensureGeminiOutputFloor(body, floor, caps)
	case "gemini-budget":
		if none && canDisable {
			geminiGenerationConfig(body).Set("thinkingConfig", obj("thinkingBudget", 0, "includeThoughts", false))
			return
		}
		b, ok := toBudget(eff, caps.ThinkingRange)
		if !ok {
			b = -1
		}
		geminiGenerationConfig(body).Set("thinkingConfig", obj("thinkingBudget", b, "includeThoughts", true))
		ensureGeminiOutputFloor(body, geminiBudgetOutputFloor(b), caps)
	case "zai":
		if none && canDisable {
			body.Set("enable_thinking", Bool(false))
			body.Delete("thinking")
			return
		}
		body.Set("thinking", obj("type", "enabled"))
		if caps.ThinkingEffortSupported {
			l := toLevel(eff)
			e := "max"
			switch l {
			case "low", "minimal":
				e = "low"
			case "high", "medium":
				e = "high"
			}
			body.Set("reasoning_effort", String(e))
		}
	case "qwen":
		if none && canDisable {
			body.Set("enable_thinking", Bool(false))
			return
		}
		body.Set("enable_thinking", Bool(true))
		if b, ok := toBudget(eff, caps.ThinkingRange); ok && finite(b) && b > 0 {
			body.Set("thinking_budget", Number(b))
		}
	case "deepseek":
		if none && canDisable {
			body.Set("thinking", obj("type", "disabled"))
			return
		}
		body.Set("thinking", obj("type", "enabled"))
		l := toLevel(eff)
		e := "high"
		if l == "xhigh" || l == "max" {
			e = "max"
		}
		body.Set("reasoning_effort", String(e))
	case "kimi":
		if none && canDisable {
			body.Set("thinking", obj("type", "disabled"))
			return
		}
		if e := toKimiReasoningEffort(eff); e != "" {
			body.Set("reasoning_effort", String(e))
		}
	case "minimax":
		t := "adaptive"
		if none && canDisable {
			t = "disabled"
		}
		body.Set("thinking", obj("type", t))
	case "step":
		if none && canDisable {
			return
		}
		if l := toLevel(eff); l != "" {
			if l == "xhigh" || l == "max" {
				l = "high"
			}
			body.Set("reasoning_effort", String(l))
		}
	case "tokenrouter":
		if none || eff.mode == "auto" {
			return
		}
		if l := toLevel(eff); l != "" {
			body.Set("reasoning_effort", String(l))
		}
	}
}

// applyThinking is thinkingUnified.applyThinking for a Claude target.
func applyThinking(targetFormat, model string, body *Value, provider string, intent *thinkingCfg, models Models) {
	if !body.IsObject() {
		return
	}
	clean, override := parseSuffix(model)
	cfg := override
	if cfg == nil {
		cfg = intent
	}
	if cfg == nil {
		cfg = extractThinking(body)
	}
	caps := models.Capabilities(provider, clean)
	if !caps.Reasoning {
		stripAllThinking(body)
		return
	}
	if cfg == nil {
		return
	}
	fmt := resolveThinkingFormat(targetFormat, caps)
	supported := models.ThinkingLevels(provider, clean)
	display := optional(body.Get("thinking")).Get("display")
	stripAllThinking(body)
	applyThinkingFormat(fmt, body, cfg, caps, supported)
	if fmt == "claude-adaptive" && display.IsString() && contains(tbl.GAThinkingDisplays, display.str) && !optional(body.Get("thinking")).Get("type").Is("disabled") {
		body.Set("thinking", obj("type", "adaptive", "display", display))
	}
}
