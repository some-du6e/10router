// Package combo resolves the model a client names into what Node would route:
// a combo and its members, an alias, or a provider/model pair, with the
// provider found through a custom node's prefix (src/sse/services/model.js,
// open-sse/services/model.js, src/lib/db/repos/combosRepo.js). Phase 2 serves
// only requests whose model is a user combo, so everything the gateway does
// with the answer is to walk the combo and check that every member it could
// reach is a provider it serves; anything else goes to Node.
//
// The data Node derives from its provider registry (provider aliases, the
// reserved prefixes, the built-in model aliases) isn't restated here:
// tables.json is exported from Node by tests/unit/gateway-combo-parity.test.js,
// which fails when the export is stale.
package combo

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"

	"github.com/some-du6e/10router/gateway/internal/db/jsjson"
	"github.com/some-du6e/10router/gateway/internal/decline"
)

//go:embed tables.json
var tablesJSON []byte

// tables is Node's registry-derived data.
type tables struct {
	// AliasToProviderID is open-sse/services/model.js's ALIAS_TO_PROVIDER_ID.
	AliasToProviderID map[string]string `json:"aliasToProviderId"`
	// LocalProviderAliases is src/sse/services/model.js's LOCAL_PROVIDER_ALIASES.
	LocalProviderAliases map[string]string `json:"localProviderAliases"`
	// ReservedProviderPrefixes is RESERVED_PROVIDER_PREFIXES.
	ReservedProviderPrefixes []string `json:"reservedProviderPrefixes"`
	// BuiltinModelAliases is BUILTIN_MODEL_ALIASES (string targets only).
	BuiltinModelAliases map[string]string `json:"builtinModelAliases"`
	// ModelPrefixProviders is MODEL_PREFIX_PROVIDERS: regex source, provider.
	ModelPrefixProviders [][2]string `json:"modelPrefixProviders"`
	// MaxComboDepth is runtimeConfig.js's MAX_COMBO_DEPTH.
	MaxComboDepth int `json:"maxComboDepth"`
}

var (
	tbl             tables
	reserved        = map[string]bool{}
	prefixProviders []prefixProvider
)

type prefixProvider struct {
	re       *regexp.Regexp
	provider string
}

func init() {
	if err := json.Unmarshal(tablesJSON, &tbl); err != nil {
		panic(fmt.Sprintf("combo: tables.json: %v", err))
	}
	for _, p := range tbl.ReservedProviderPrefixes {
		reserved[p] = true
	}
	for _, pp := range tbl.ModelPrefixProviders {
		prefixProviders = append(prefixProviders, prefixProvider{regexp.MustCompile(pp[0]), pp[1]})
	}
	if tbl.MaxComboDepth <= 0 {
		panic("combo: tables.json has no maxComboDepth")
	}
}

// MaxComboDepth is Node's MAX_COMBO_DEPTH.
func MaxComboDepth() int { return tbl.MaxComboDepth }

// BuiltinModelAlias is BUILTIN_MODEL_ALIASES[alias].
func BuiltinModelAlias(alias string) (string, bool) {
	v, ok := tbl.BuiltinModelAliases[alias]
	return v, ok
}

func declined(format string, args ...any) error { return decline.New("combo", format, args...) }

// protoKeys are Object.prototype's members. Node looks model ids up in plain
// objects (the alias tables, aliases from the database), where one of these
// finds an inherited function instead of nothing, so an id that names one is
// left to Node.
var protoKeys = []string{
	"__proto__", "constructor", "hasOwnProperty", "isPrototypeOf", "propertyIsEnumerable",
	"toLocaleString", "toString", "valueOf", "__defineGetter__", "__defineSetter__",
	"__lookupGetter__", "__lookupSetter__",
}

// HasProtoKey reports whether s contains a name an object lookup would find
// on Object.prototype.
func HasProtoKey(s string) bool {
	for _, k := range protoKeys {
		if strings.Contains(s, k) {
			return true
		}
	}
	return false
}

// CheckID declines ids Node would read differently: Object.prototype names,
// and anything but printable ASCII (JavaScript's toLowerCase maps some
// non-ASCII letters to ASCII ones, the Kelvin sign to "k"). pkg names the
// package that declines.
func CheckID(pkg, what, s string) error {
	if HasProtoKey(s) {
		return decline.New(pkg, "%s names an Object.prototype member", what)
	}
	return decline.ASCII(pkg, what, s)
}

// contextWindowSuffix is /\[(\d+[km])\]$/i.
var contextWindowSuffix = regexp.MustCompile(`(?i)\[[0-9]+[km]\]$`)

// StripContextWindowSuffix is stripContextWindowSuffix's model:
// "claude-opus-5[1m]" → "claude-opus-5".
func StripContextWindowSuffix(model string) string {
	if loc := contextWindowSuffix.FindStringIndex(model); loc != nil {
		return model[:loc[0]]
	}
	return model
}

// StripContextMarker is modelMarkers.js's stripModelContextMarker: Claude
// Code's "[1m]" marker comes off a trimmed id; without one the id is returned
// as it was. For an ASCII id (JavaScript's trim also removes Unicode spaces).
func StripContextMarker(model string) (string, bool) {
	t := strings.Trim(model, " \t\n\v\f\r")
	if len(t) >= 4 && strings.EqualFold(t[len(t)-4:], "[1m]") {
		return t[:len(t)-4], true
	}
	return model, false
}

// ComboLookupName is comboLookupName: the name combos are stored under.
func ComboLookupName(model string) string { return StripContextWindowSuffix(model) }

// resolveProviderAlias is resolveProviderAlias.
func resolveProviderAlias(aliasOrID string) string {
	if id, ok := tbl.AliasToProviderID[aliasOrID]; ok && id != "" {
		return id
	}
	return aliasOrID
}

// Parsed is parseModel's result (its context window is never read on the
// hot path).
type Parsed struct {
	Provider      string
	Model         string
	IsAlias       bool
	ProviderAlias string
}

// ParseModel is src/sse/services/model.js's parseModel: the core parse, then
// the local provider aliases. The caller has checked the id (CheckID).
func ParseModel(modelStr string) Parsed {
	if modelStr == "" {
		return Parsed{}
	}
	stripped := StripContextWindowSuffix(modelStr)
	if i := strings.IndexByte(stripped, '/'); i >= 0 {
		alias := stripped[:i]
		p := Parsed{Provider: resolveProviderAlias(alias), Model: stripped[i+1:], ProviderAlias: alias}
		if local, ok := tbl.LocalProviderAliases[alias]; ok && local != "" {
			p.Provider = local
		}
		return p
	}
	return Parsed{Model: stripped, IsAlias: true}
}

// Node is a provider node as getModelInfo matches it.
type Node struct {
	ID   string
	Type string
	// Prefix is the node's prefix when it is a string.
	Prefix    string
	HasPrefix bool
}

// Config is what resolution reads from the database, one snapshot's worth.
type Config struct {
	// Nodes in table order (getProviderNodes has no ORDER BY: rowid order).
	Nodes []Node
	// Combos by name: the stored models value as rowToCombo reads it
	// (parseJson(row.models, []), normally an array).
	Combos map[string]any
	// Aliases is the modelAliases kv scope.
	Aliases *jsjson.Object
}

// Info is getModelInfo's result. A combo name has no provider.
type Info struct {
	Provider string
	Model    string
	// IsCombo: the id names a combo (provider null in Node).
	IsCombo bool
}

// nodeTypes are the node types getModelInfo looks a prefix up in, in its order.
var nodeTypes = []string{"openai-compatible", "anthropic-compatible", "custom-embedding"}

// ModelInfo is src/sse/services/model.js's getModelInfo.
func (c *Config) ModelInfo(modelStr string) (Info, error) {
	if err := CheckID("combo", "model id", modelStr); err != nil {
		return Info{}, err
	}
	if modelStr == "" {
		// parseModel's nulls. Node can still match a node stored with
		// "prefix": null (null === null), but its model stays null and the
		// request is refused later; here it resolves to nothing, which no
		// served provider is.
		return Info{}, nil
	}
	p := ParseModel(modelStr)
	if !p.IsAlias {
		if !reserved[p.ProviderAlias] {
			for _, typ := range nodeTypes {
				for _, n := range c.Nodes {
					if n.Type == typ && n.HasPrefix && n.Prefix == p.ProviderAlias {
						return Info{Provider: n.ID, Model: p.Model}, nil
					}
				}
			}
		}
		return Info{Provider: p.Provider, Model: p.Model}, nil
	}
	// A combo name before an alias.
	if _, ok := c.Combos[p.Model]; ok {
		return Info{Model: p.Model, IsCombo: true}, nil
	}
	return c.modelInfoCore(modelStr)
}

// modelInfoCore is getModelInfoCore for an alias-shaped id.
func (c *Config) modelInfoCore(modelStr string) (Info, error) {
	p := ParseModel(modelStr)
	// kvStore.getAll builds the aliases by assignment, and assigning a
	// "__proto__" object replaces the map's prototype: Node then finds the
	// aliases in it by inheritance, which a plain lookup here wouldn't.
	if v, ok := c.Aliases.Get("__proto__"); ok {
		switch v.(type) {
		case *jsjson.Object, []any:
			return Info{}, declined("a stored __proto__ alias Node's alias map inherits from")
		}
	}
	if info, ok, err := resolveAliasFrom(p.Model, c.Aliases); err != nil || ok {
		return info, err
	}
	if target, ok := tbl.BuiltinModelAliases[p.Model]; ok {
		if info, ok := splitAlias(target); ok {
			return info, nil
		}
	}
	return Info{Provider: inferProvider(p.Model), Model: p.Model}, nil
}

// resolveAliasFrom is resolveModelAliasFromMap over the stored aliases.
func resolveAliasFrom(alias string, aliases *jsjson.Object) (Info, bool, error) {
	v, ok := aliases.Get(alias)
	if !ok || !jsjson.Truthy(v) {
		return Info{}, false, nil
	}
	switch t := v.(type) {
	case string:
		if HasProtoKey(t) {
			return Info{}, false, declined("alias %q names an Object.prototype member", alias)
		}
		info, ok := splitAlias(t)
		return info, ok, nil
	case *jsjson.Object:
		prov, _ := t.Get("provider")
		model, _ := t.Get("model")
		if !jsjson.Truthy(prov) || !jsjson.Truthy(model) {
			return Info{}, false, nil
		}
		ps, ok1 := prov.(string)
		ms, ok2 := model.(string)
		if !ok1 || !ok2 || HasProtoKey(ps) {
			return Info{}, false, declined("alias %q stores a non-string provider or model", alias)
		}
		return Info{Provider: resolveProviderAlias(ps), Model: ms}, true, nil
	}
	// A truthy number, boolean or array: Node returns null too.
	return Info{}, false, nil
}

func splitAlias(target string) (Info, bool) {
	i := strings.IndexByte(target, '/')
	if i < 0 {
		return Info{}, false
	}
	return Info{Provider: resolveProviderAlias(target[:i]), Model: target[i+1:]}, true
}

// inferProvider is inferProviderFromModelName.
func inferProvider(model string) string {
	if model == "" {
		return "openai"
	}
	m := jsLower(model)
	for _, pp := range prefixProviders {
		if pp.re.MatchString(m) {
			return pp.provider
		}
	}
	return "openai"
}

// jsLower is toLowerCase for an ASCII id (CheckID).
func jsLower(s string) string {
	b := []byte(s)
	for i, c := range b {
		if c >= 'A' && c <= 'Z' {
			b[i] = c + 32
		}
	}
	return string(b)
}

// ComboModels is getComboModels: the members of the combo the id names, or
// nil when it names none. A combo whose stored members aren't all strings is
// declined: Node would route them however its loops read them.
func (c *Config) ComboModels(modelStr string) ([]string, error) {
	if strings.Contains(modelStr, "/") {
		return nil, nil
	}
	name := ComboLookupName(modelStr)
	// getComboByName's lookup is exact (binary collation, a UNIQUE name).
	if err := CheckID("combo", "combo name", name); err != nil {
		return nil, err
	}
	stored, ok := c.Combos[name]
	if !ok {
		return nil, nil
	}
	// combo.models && combo.models.length > 0: an array, or a string Node
	// would iterate by character.
	models, isArray := stored.([]any)
	if !isArray {
		// A non-empty string, or an object with a length, passes that check in
		// Node and is iterated however its loops read it.
		switch t := stored.(type) {
		case string:
			if t != "" {
				return nil, declined("combo %q stores its members as a string", name)
			}
		case *jsjson.Object:
			return nil, declined("combo %q stores its members as an object", name)
		}
		return nil, nil
	}
	if len(models) == 0 {
		return nil, nil
	}
	out := make([]string, 0, len(models))
	for _, m := range models {
		s, ok := m.(string)
		if !ok {
			return nil, declined("combo %q has a member that is not a string", name)
		}
		out = append(out, s)
	}
	return out, nil
}
