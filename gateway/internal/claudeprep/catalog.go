package claudeprep

import (
	"math"
	"os"
	"strings"
	"sync"
	"time"
)

// FileCatalog is open-sse/providers/catalogOverride.js: the model catalog
// Node syncs from models.dev into DATA_DIR/model-catalog.json, read through
// capabilities.js's setCatalogSource. The file is the source of truth; the
// parsed copy is dropped whenever its mtime changes, and a missing file or
// one JSON.parse refuses is an empty catalog, as in Node.
//
// sync.js writes {models: {id: {vision: true, ...}}, providers: {provider:
// {model: {contextWindow, maxOutput}}}}. Shapes it never writes, which JS
// would index its own way (an array where an object goes, a maxOutput that
// isn't a finite number), decline the request when Prepare consults them.
type FileCatalog struct {
	path string

	mu      sync.Mutex
	mtime   time.Time
	present bool
	// models and providers are parsed?.models || {} and parsed?.providers
	// || {}: nil for the {}.
	models, providers *Value
}

// NewFileCatalog reads the catalog at path (Node's CATALOG_FILE).
func NewFileCatalog(path string) *FileCatalog { return &FileCatalog{path: path} }

// catalogBaseID is catalogOverride.js's baseId: "zai-org/GLM-4.6V:free" is
// "glm-4.6v". Prepare's model ids are ASCII, where Go's ToLower is JS's.
func catalogBaseID(model string) string {
	base, _, _ := strings.Cut(strings.ToLower(lastSegment(model)), ":")
	return base
}

func (c *FileCatalog) load() (models, providers *Value) {
	c.mu.Lock()
	defer c.mu.Unlock()
	st, err := os.Stat(c.path)
	if err != nil {
		c.present, c.models, c.providers = false, nil, nil
		return nil, nil
	}
	if c.present && st.ModTime().Equal(c.mtime) {
		return c.models, c.providers
	}
	c.present, c.mtime, c.models, c.providers = true, st.ModTime(), nil, nil
	raw, err := os.ReadFile(c.path)
	if err != nil {
		return nil, nil
	}
	// readFileSync(file, "utf8") keeps a BOM, which JSON.parse refuses.
	top, err := parseText(decodeUTF8KeepBOM(raw))
	if err != nil {
		return nil, nil
	}
	// Built here, under the lock: a lookup on a large object would otherwise
	// build its index lazily, racing with other requests reading it.
	indexAll(top)
	if m := top.Get("models"); m.Truthy() {
		c.models = m
	}
	if p := top.Get("providers"); p.Truthy() {
		c.providers = p
	}
	return c.models, c.providers
}

func indexAll(v *Value) {
	switch v.Kind() {
	case KindObject:
		v.obj.reindex()
		for _, m := range v.obj.members {
			indexAll(m.val)
		}
	case KindArray:
		for _, item := range v.arr {
			indexAll(item)
		}
	}
}

// emptyEntry stands for what JS finds under an Object.prototype name that
// isn't an own key: a function or the prototype, holding no catalog field.
var emptyEntry = Object()

// catalogMember is container[key] for the shapes sync.js writes: an object's
// own key, else emptyEntry for an Object.prototype name. An array, where JS
// would index by key, declines. A string, number or true reads a character or
// nothing in JS, and neither holds a catalog field.
func catalogMember(container *Value, key string) *Value {
	switch container.Kind() {
	case KindObject:
		if v := container.Get(key); v != nil {
			return v
		}
		if isProtoName(key) {
			return emptyEntry
		}
	case KindArray:
		decline("a model catalog file with an array Node would index")
	}
	return nil
}

// entryObject is a looked-up entry as refine reads its fields: nil when it
// holds none.
func entryObject(entry *Value) *Value {
	if entry.IsArray() {
		decline("a model catalog file with an array Node would index")
	}
	if entry.IsObject() {
		return entry
	}
	return nil
}

// Modalities is getCatalogModalities: models[baseId(model)], each modality
// on only when it is exactly true.
func (c *FileCatalog) Modalities(model string) (Modalities, bool) {
	models, _ := c.load()
	entry := catalogMember(models, catalogBaseID(model))
	if !entry.Truthy() {
		return Modalities{}, false
	}
	obj := entryObject(entry)
	isTrue := func(k string) bool { v := obj.Get(k); return v.Kind() == KindBool && v.b }
	return Modalities{Vision: isTrue("vision"), PDF: isTrue("pdf"), AudioInput: isTrue("audioInput")}, true
}

// DeclineCovered is the catalog the native route prepares with: Node's
// request handlers apply the synced catalog only once a sync has run in
// them (POST /api/models/catalog-sync installs the source in their copy of
// capabilities.js; the one instrumentation installs at boot is another
// module copy), so whether Node reads it depends on the process's history.
// A request it could change declines: a maxOutput for the model (the
// max_tokens ceiling), or a modality it declares (stripUnsupportedModalities
// keeps or replaces media in earlier turns and tool results by it, which
// combo.MayNeedCapability, reading only the current turn, lets through). With
// no such entry both sides agree either way. Lookups only reach the catalog
// from refine, for models the hand tables don't name.
func DeclineCovered(c Catalog) Catalog { return coveredDeclines{c} }

type coveredDeclines struct{ c Catalog }

func (d coveredDeclines) Modalities(model string) (Modalities, bool) {
	if m, ok := d.c.Modalities(model); ok && (m.Vision || m.PDF || m.AudioInput) {
		decline("the synced model catalog declares a modality for this model (Node's request handlers read the catalog only after a sync ran in them)")
	}
	return Modalities{}, false
}

func (d coveredDeclines) Limits(provider, model string) (Limits, bool) {
	if l, ok := d.c.Limits(provider, model); ok && l.MaxOutput > 0 {
		decline("the synced model catalog has a maxOutput for this model (Node's request handlers read the catalog only after a sync ran in them)")
	}
	return Limits{}, false
}

// Limits is getCatalogLimits: providers[provider][model], else by baseId,
// whichever is truthy first; maxOutput counts when it is a positive number.
func (c *FileCatalog) Limits(provider, model string) (Limits, bool) {
	if provider == "" {
		return Limits{}, false
	}
	_, providers := c.load()
	byProvider := catalogMember(providers, provider)
	if !byProvider.Truthy() {
		return Limits{}, false
	}
	entry := catalogMember(byProvider, model)
	if !entry.Truthy() {
		entry = catalogMember(byProvider, catalogBaseID(model))
	}
	if !entry.Truthy() {
		return Limits{}, false
	}
	out := Limits{}
	switch v := entryObject(entry).Get("maxOutput"); {
	case v.IsNullish():
	case v.IsNumber():
		if math.IsInf(v.f, 0) {
			decline("a model catalog maxOutput beyond a float64")
		}
		if v.f > 0 {
			out.MaxOutput = v.f
		}
	default:
		// JS compares it with > 0 by coercion ("5", true, [5]) and keeps the
		// original value.
		decline("a model catalog maxOutput that isn't a number")
	}
	return out, true
}
