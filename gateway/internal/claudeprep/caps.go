package claudeprep

import (
	_ "embed"
	"encoding/json"
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
	ThinkingBudgetAccepted       bool
	ForcedToolChoice             bool
	ForcedToolChoiceWithThinking bool
	ContextWindow                float64
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
	ThinkingBudgetAccepted       *bool          `json:"thinkingBudgetAccepted"`
	ForcedToolChoice             *bool          `json:"forcedToolChoice"`
	ForcedToolChoiceWithThinking *bool          `json:"forcedToolChoiceWithThinking"`
	ContextWindow                *float64       `json:"contextWindow"`
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
	setBool(&c.ThinkingBudgetAccepted, p.ThinkingBudgetAccepted)
	setBool(&c.ForcedToolChoice, p.ForcedToolChoice)
	setBool(&c.ForcedToolChoiceWithThinking, p.ForcedToolChoiceWithThinking)
	if p.ContextWindow != nil {
		c.ContextWindow = *p.ContextWindow
	}
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
	ThinkingDefaultLevels []string          `json:"thinkingDefaultLevels"`
	VisionNotPattern      string            `json:"visionNotPattern"`
	VisionPattern         string            `json:"visionPattern"`
	MimicHeaders          map[string]string `json:"mimicHeaders"`
}

var (
	tbl       tables
	notVision *regexp.Regexp
	visionRe  *regexp.Regexp
)

func init() {
	if err := json.Unmarshal(tablesJSON, &tbl); err != nil {
		panic("claudeprep: tables.json: " + err.Error())
	}
	notVision = regexp.MustCompile("(?i)" + tbl.VisionNotPattern)
	visionRe = regexp.MustCompile("(?i)" + tbl.VisionPattern)
}

// Catalog is the synced model catalog capabilities.js reads through
// setCatalogSource (models.dev data, refreshed by Node): modalities by model,
// limits by provider and model. It only ever turns a capability on.
type Catalog interface {
	Modalities(model string) (Modalities, bool)
	Limits(provider, model string) (Limits, bool)
}

// Modalities is a catalog entry's input modalities (true = declared).
type Modalities struct {
	Vision, PDF, AudioInput, VideoInput bool
}

// Limits is a catalog entry's token limits (0 = not given).
type Limits struct {
	ContextWindow, MaxOutput float64
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
	if isProtoName(model) || isProtoName(lastSegment(model)) || isProtoName(provider) {
		decline("a model or provider id that names an Object.prototype member")
	}
	base := lastSegment(model)
	if provider != "" {
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
	}
	if p, ok := tbl.ModelCapabilities[base]; ok {
		c := defaultCaps()
		p.apply(&c)
		return c
	}
	if p, ok := tbl.ModelCapabilities[model]; ok {
		c := defaultCaps()
		p.apply(&c)
		return c
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
			if lim.ContextWindow > 0 {
				c.ContextWindow = lim.ContextWindow
			}
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
	if provider == "kiro" {
		decline("kiro thinking levels")
	}
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
