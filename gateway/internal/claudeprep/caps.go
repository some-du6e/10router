package claudeprep

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
)

// Model capabilities, ported from open-sse/providers/capabilities.js and
// thinkingLevels.js. The tables themselves are not restated here: tables.json
// is exported from Node by tests/unit/gateway-claudeprep-parity.test.js, which
// fails when Node's tables change and the export doesn't.

//go:embed tables.json
var tablesJSON []byte

// Caps is getCapabilitiesForModel's result, the fields the request
// preparation reads.
type Caps struct {
	Vision                       bool
	PDF                          bool
	AudioInput                   bool
	Reasoning                    bool
	ThinkingFormat               string // "" is null
	ThinkingCanDisable           bool
	ThinkingRange                *ThinkingRange
	ThinkingEffortSupported      bool
	ForcedToolChoice             bool
	ForcedToolChoiceWithThinking bool
	MaxOutput                    float64
}

// ThinkingRange is a budget format's { min, max } clamp; a nil bound is none.
type ThinkingRange struct {
	Min *float64 `json:"min"`
	Max *float64 `json:"max"`
}

// capsPatch is one table entry: only the fields it declares.
type capsPatch struct {
	Vision                       *bool          `json:"vision"`
	PDF                          *bool          `json:"pdf"`
	AudioInput                   *bool          `json:"audioInput"`
	Reasoning                    *bool          `json:"reasoning"`
	ThinkingFormat               *string        `json:"thinkingFormat"`
	ThinkingCanDisable           *bool          `json:"thinkingCanDisable"`
	ThinkingRange                *ThinkingRange `json:"thinkingRange"`
	ThinkingEffortSupported      *bool          `json:"thinkingEffortSupported"`
	ForcedToolChoice             *bool          `json:"forcedToolChoice"`
	ForcedToolChoiceWithThinking *bool          `json:"forcedToolChoiceWithThinking"`
	MaxOutput                    *float64       `json:"maxOutput"`
}

func (p *capsPatch) apply(c *Caps) {
	setBool := func(dst *bool, src *bool) {
		if src != nil {
			*dst = *src
		}
	}
	setBool(&c.Vision, p.Vision)
	setBool(&c.PDF, p.PDF)
	setBool(&c.AudioInput, p.AudioInput)
	setBool(&c.Reasoning, p.Reasoning)
	if p.ThinkingFormat != nil {
		c.ThinkingFormat = *p.ThinkingFormat
	}
	setBool(&c.ThinkingCanDisable, p.ThinkingCanDisable)
	if p.ThinkingRange != nil {
		c.ThinkingRange = p.ThinkingRange
	}
	setBool(&c.ThinkingEffortSupported, p.ThinkingEffortSupported)
	setBool(&c.ForcedToolChoice, p.ForcedToolChoice)
	setBool(&c.ForcedToolChoiceWithThinking, p.ForcedToolChoiceWithThinking)
	if p.MaxOutput != nil {
		c.MaxOutput = *p.MaxOutput
	}
}

type tables struct {
	DefaultCapabilities  capsPatch                       `json:"defaultCapabilities"`
	ModelCapabilities    map[string]capsPatch            `json:"modelCapabilities"`
	ProviderCapabilities map[string]map[string]capsPatch `json:"providerCapabilities"`
	PatternCapabilities  []struct {
		Pattern string    `json:"pattern"`
		Caps    capsPatch `json:"caps"`
	} `json:"patternCapabilities"`
	ThinkingFormatLevels  map[string][]string `json:"thinkingFormatLevels"`
	ThinkingPatternLevels []struct {
		Provider string   `json:"provider"`
		Pattern  string   `json:"pattern"`
		Levels   []string `json:"levels"`
	} `json:"thinkingPatternLevels"`
	ThinkingDefaultLevels []string            `json:"thinkingDefaultLevels"`
	VisionNotPattern      string              `json:"visionNotPattern"`
	VisionPattern         string              `json:"visionPattern"`
	MimicHeaders          map[string]string   `json:"mimicHeaders"`
	BetaBodyFields        map[string][]string `json:"betaBodyFields"`
	FirstPartyBetaFields  map[string][]string `json:"firstPartyBetaFields"`
	ToolChangeBetas       map[string][]string `json:"toolChangeBetas"`
	LevelToBudget         map[string]float64  `json:"levelToBudget"`
	GAThinkingDisplays    []string            `json:"gaThinkingDisplays"`
	Constants             struct {
		WebSearchToolType         string  `json:"webSearchToolType"`
		DefaultMaxTokens          float64 `json:"defaultMaxTokens"`
		AnthropicAPIVersion       string  `json:"anthropicApiVersion"`
		AnthropicAPIHost          string  `json:"anthropicApiHost"`
		ClaudeSystemPrompt        string  `json:"claudeSystemPrompt"`
		LimitHoldSentinel         string  `json:"limitHoldSentinel"`
		InterruptedToolResultText string  `json:"interruptedToolResultText"`
		PrefillContinuationText   string  `json:"prefillContinuationText"`
	} `json:"constants"`
}

var (
	tbl       tables
	notVision *regexp.Regexp
	visionRe  *regexp.Regexp
)

// loadErr is why tables.json didn't load: Ready reports it, so the gateway
// (which links this package in every mode) turns the native route off
// instead of failing to start.
var loadErr error

func init() { loadErr = loadTables() }

// Ready is nil when the embedded tables loaded; nothing else here may be
// called otherwise.
func Ready() error { return loadErr }

func loadTables() (err error) {
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("%v", r)
		}
	}()
	if err := json.Unmarshal(tablesJSON, &tbl); err != nil {
		panic("claudeprep: tables.json: " + err.Error())
	}
	notVision = regexp.MustCompile("(?i)" + tbl.VisionNotPattern)
	visionRe = regexp.MustCompile("(?i)" + tbl.VisionPattern)
	k := tbl.Constants
	defaultMaxTokens, anthropicAPIVersion, anthropicAPIHost = k.DefaultMaxTokens, k.AnthropicAPIVersion, k.AnthropicAPIHost
	claudeSystemPrompt, interruptedToolResultText, prefillContinuationText = k.ClaudeSystemPrompt, k.InterruptedToolResultText, k.PrefillContinuationText
	limitHoldSentinel, webSearchToolType = k.LimitHoldSentinel, k.WebSearchToolType
	limitHoldNotice = `Some assistant messages in this conversation contain a status line marked ` +
		`"` + limitHoldSentinel + `". Those lines were inserted by the 10router gateway to report ` +
		`an upstream rate limit while the request waited ` + "—" + ` they are not your output and not ` +
		`part of the conversation. Ignore them completely: do not comment on them, apologise ` +
		`for them, or reproduce them in your reply.`
	// FIRST_PARTY_BETAS (anthropicBeta.ts): the first-party field flags, then every tool-change flag.
	for flag := range tbl.FirstPartyBetaFields {
		firstPartyBetas = append(firstPartyBetas, flag)
	}
	for _, flags := range tbl.ToolChangeBetas {
		firstPartyBetas = union(firstPartyBetas, flags)
	}
	for _, s := range []string{anthropicAPIVersion, anthropicAPIHost, claudeSystemPrompt, interruptedToolResultText, prefillContinuationText, limitHoldSentinel, webSearchToolType} {
		if s == "" {
			panic("claudeprep: tables.json is missing a constant")
		}
	}
	if defaultMaxTokens <= 0 || len(tbl.BetaBodyFields) == 0 || len(tbl.FirstPartyBetaFields) == 0 || len(tbl.ToolChangeBetas) == 0 ||
		len(tbl.LevelToBudget) == 0 || len(tbl.GAThinkingDisplays) == 0 || len(tbl.ModelCapabilities) == 0 || len(tbl.PatternCapabilities) == 0 {
		panic("claudeprep: tables.json is missing a table")
	}
	return nil
}

// Node's constants, from tables.json.
var (
	defaultMaxTokens          float64
	anthropicAPIVersion       string
	anthropicAPIHost          string
	claudeSystemPrompt        string
	interruptedToolResultText string
	prefillContinuationText   string
	limitHoldSentinel         string
	webSearchToolType         string
	// limitHoldNotice is limitHoldNotice.js NOTICE (not exported there; the
	// limit-hold fixtures hold it to Node's text).
	limitHoldNotice string
	firstPartyBetas []string
)

// Catalog is the synced model catalog capabilities.js reads through
// setCatalogSource (models.dev data, refreshed by Node): modalities by model,
// limits by provider and model. It only ever turns a capability on.
type Catalog interface {
	Modalities(model string) (Modalities, bool)
	Limits(provider, model string) (Limits, bool)
}

// Modalities is a catalog entry's input modalities the preparation reads
// (true = declared).
type Modalities struct {
	Vision, PDF, AudioInput bool
}

// Limits is a catalog entry's output limit (0 = not given). The context
// window it also carries changes nothing here.
type Limits struct {
	MaxOutput float64
}

// Models resolves what the preparation needs to know about a model. The
// default, NewModels, is the port of capabilities.js over the embedded
// tables; phase 2b supplies the catalog Node syncs.
type Models interface {
	Capabilities(provider, model string) Caps
	// ThinkingLevels is getThinkingLevels: nil when the model doesn't reason.
	ThinkingLevels(provider, model string) []string
}

type tableModels struct{ catalog Catalog }

// NewModels is capabilities.js with catalog (nil: none installed).
func NewModels(catalog Catalog) Models { return tableModels{catalog} }

func defaultCaps() Caps {
	var c Caps
	tbl.DefaultCapabilities.apply(&c)
	return c
}

func lastSegment(model string) string {
	if i := strings.LastIndexByte(model, '/'); i >= 0 {
		return model[i+1:]
	}
	return model
}

func (m tableModels) Capabilities(provider, model string) Caps {
	if model == "" {
		return defaultCaps()
	}
	base := lastSegment(model)
	// PROVIDER_CAPABILITIES[provider || resolveProviderAlias(provider)]: an
	// openai-compatible node id is neither a table key nor an alias.
	if pc, ok := tbl.ProviderCapabilities[provider]; ok {
		if p, ok := pc[model]; ok {
			c := defaultCaps()
			p.apply(&c)
			return c
		}
		if p, ok := pc[base]; ok {
			c := defaultCaps()
			p.apply(&c)
			return c
		}
	}
	// MODEL_CAPABILITIES[id] for an Object.prototype name finds a function
	// (or the prototype), whose spread adds nothing: the defaults, unrefined.
	if p, ok := tbl.ModelCapabilities[base]; ok {
		c := defaultCaps()
		p.apply(&c)
		return c
	}
	if isProtoName(base) {
		return defaultCaps()
	}
	if p, ok := tbl.ModelCapabilities[model]; ok {
		c := defaultCaps()
		p.apply(&c)
		return c
	}
	if isProtoName(model) {
		return defaultCaps()
	}
	for _, e := range tbl.PatternCapabilities {
		if matchPattern(e.Pattern, base) || matchPattern(e.Pattern, model) {
			return m.refine(&e.Caps, provider, model)
		}
	}
	return m.refine(nil, provider, model)
}

func (m tableModels) refine(p *capsPatch, provider, model string) Caps {
	c := defaultCaps()
	if p != nil {
		p.apply(&c)
	}
	if m.catalog != nil {
		if mod, ok := m.catalog.Modalities(model); ok {
			c.Vision = c.Vision || mod.Vision
			c.PDF = c.PDF || mod.PDF
			c.AudioInput = c.AudioInput || mod.AudioInput
		}
		if lim, ok := m.catalog.Limits(provider, model); ok {
			if lim.MaxOutput > 0 {
				c.MaxOutput = lim.MaxOutput
			}
		}
	}
	if !c.Vision && looksLikeVisionModel(model) {
		c.Vision = true
	}
	return c
}

func looksLikeVisionModel(model string) bool {
	if model == "" {
		return false
	}
	id := strings.ToLower(model)
	if notVision.MatchString(id) {
		return false
	}
	return visionRe.MatchString(id)
}

func (m tableModels) ThinkingLevels(provider, model string) []string {
	// (Node's kiro special case can't apply: Prepare takes openai-compatible nodes only.)
	c := m.Capabilities(provider, model)
	if !c.Reasoning {
		return nil
	}
	var levels []string
	found := false
	for _, e := range tbl.ThinkingPatternLevels {
		if (e.Provider == "" || e.Provider == provider) && matchPattern(e.Pattern, model) {
			levels, found = e.Levels, true
			break
		}
	}
	if !found {
		if l, ok := tbl.ThinkingFormatLevels[c.ThinkingFormat]; ok && c.ThinkingFormat != "" {
			levels = l
		} else {
			levels = tbl.ThinkingDefaultLevels
		}
	}
	if !c.ThinkingCanDisable {
		kept := make([]string, 0, len(levels))
		for _, l := range levels {
			if l != "none" {
				kept = append(kept, l)
			}
		}
		levels = kept
	}
	return levels
}

// matchPattern is pricing.js matchPattern: a glob ("*" any run), anchored,
// ASCII case-insensitive. Ids reaching it are printable ASCII (checked in
// Prepare), where JavaScript's /i and "." agree with this.
func matchPattern(pattern, s string) bool {
	parts := strings.Split(pattern, "*")
	if len(parts) == 1 {
		return strings.EqualFold(pattern, s)
	}
	if !hasPrefixFold(s, parts[0]) {
		return false
	}
	s = s[len(parts[0]):]
	last := parts[len(parts)-1]
	for _, mid := range parts[1 : len(parts)-1] {
		i := indexFold(s, mid)
		if i < 0 {
			return false
		}
		s = s[i+len(mid):]
	}
	return len(s) >= len(last) && strings.EqualFold(s[len(s)-len(last):], last)
}

func hasPrefixFold(s, prefix string) bool {
	return len(s) >= len(prefix) && strings.EqualFold(s[:len(prefix)], prefix)
}

func indexFold(s, sub string) int {
	for i := 0; i+len(sub) <= len(s); i++ {
		if strings.EqualFold(s[i:i+len(sub)], sub) {
			return i
		}
	}
	return -1
}

// Object.prototype's members: a plain-object lookup by one of these finds an
// inherited function in JavaScript, which the port doesn't model.
var protoNames = map[string]bool{
	"constructor": true, "__proto__": true, "toString": true, "toLocaleString": true, "valueOf": true,
	"hasOwnProperty": true, "isPrototypeOf": true, "propertyIsEnumerable": true,
	"__defineGetter__": true, "__defineSetter__": true, "__lookupGetter__": true, "__lookupSetter__": true,
}

func isProtoName(s string) bool { return protoNames[s] }
