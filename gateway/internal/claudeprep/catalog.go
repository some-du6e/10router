package claudeprep

import (
	"bytes"
	"encoding/json"
	"io"
	"math"
	"os"
	"strconv"
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
	parsed  catalogFile
}

type catalogFile struct {
	models, providers any
}

// NewFileCatalog reads the catalog at path (Node's CATALOG_FILE).
func NewFileCatalog(path string) *FileCatalog { return &FileCatalog{path: path} }

// catalogBaseID is catalogOverride.js's baseId: "zai-org/GLM-4.6V:free" is
// "glm-4.6v". Prepare's model ids are ASCII, where Go's ToLower is JS's.
func catalogBaseID(model string) string {
	if model == "" {
		return ""
	}
	if i := strings.LastIndexByte(model, '/'); i >= 0 {
		model = model[i+1:]
	}
	model = strings.ToLower(model)
	if i := strings.IndexByte(model, ':'); i >= 0 {
		model = model[:i]
	}
	return model
}

func (c *FileCatalog) load() catalogFile {
	c.mu.Lock()
	defer c.mu.Unlock()
	st, err := os.Stat(c.path)
	if err != nil {
		c.present, c.parsed = false, catalogFile{}
		return c.parsed
	}
	if c.present && st.ModTime().Equal(c.mtime) {
		return c.parsed
	}
	c.present, c.mtime, c.parsed = true, st.ModTime(), catalogFile{}
	raw, err := os.ReadFile(c.path)
	if err != nil {
		return c.parsed
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	var top any
	if dec.Decode(&top) != nil {
		return c.parsed
	}
	if _, err := dec.Token(); err != io.EOF {
		// Trailing data: JSON.parse throws.
		return c.parsed
	}
	// parsed?.models || {}: a falsy value (or a non-object document) is {}.
	if obj, ok := top.(map[string]any); ok {
		c.parsed = catalogFile{models: truthyOrNil(obj["models"]), providers: truthyOrNil(obj["providers"])}
	}
	return c.parsed
}

func truthyOrNil(v any) any {
	if !jsTruthy(v) {
		return nil
	}
	return v
}

// catalogMember is container[key] for the shapes sync.js writes: an object's
// own key. Object.prototype's names, absent as own keys, find a function in
// JS, which holds no catalog fields (found, empty). An array, where JS would
// index by key, declines.
func catalogMember(container any, key string) (v any, found bool) {
	switch t := container.(type) {
	case nil:
		return nil, false
	case map[string]any:
		if v, ok := t[key]; ok {
			return v, true
		}
		if isProtoName(key) {
			return map[string]any{}, true
		}
		return nil, false
	case []any:
		decline("a model catalog file with an array Node would index")
	}
	// A string, number or true: JS reads a character or nothing, and neither
	// holds a catalog field.
	return nil, false
}

// Modalities is getCatalogModalities: models[baseId(model)], each modality
// on only when it is exactly true.
func (c *FileCatalog) Modalities(model string) (Modalities, bool) {
	entry, _ := catalogMember(c.load().models, catalogBaseID(model))
	if !jsTruthy(entry) {
		return Modalities{}, false
	}
	obj, _ := entry.(map[string]any)
	if _, isArray := entry.([]any); isArray {
		decline("a model catalog file with an array Node would index")
	}
	return Modalities{Vision: obj["vision"] == true, PDF: obj["pdf"] == true, AudioInput: obj["audioInput"] == true}, true
}

// Limits is getCatalogLimits: providers[provider][model], else by baseId,
// whichever is truthy first; maxOutput counts when it is a positive number.
func (c *FileCatalog) Limits(provider, model string) (Limits, bool) {
	if provider == "" {
		return Limits{}, false
	}
	byProvider, _ := catalogMember(c.load().providers, provider)
	if !jsTruthy(byProvider) {
		return Limits{}, false
	}
	entry, _ := catalogMember(byProvider, model)
	if !jsTruthy(entry) {
		entry, _ = catalogMember(byProvider, catalogBaseID(model))
	}
	if !jsTruthy(entry) {
		return Limits{}, false
	}
	obj, _ := entry.(map[string]any)
	if _, isArray := entry.([]any); isArray {
		decline("a model catalog file with an array Node would index")
	}
	out := Limits{}
	switch v := obj["maxOutput"].(type) {
	case nil:
	case json.Number:
		n, err := strconv.ParseFloat(string(v), 64)
		if err != nil || math.IsInf(n, 0) {
			decline("a model catalog maxOutput beyond a float64")
		}
		if n > 0 {
			out.MaxOutput = n
		}
	default:
		// JS compares it with > 0 by coercion ("5", true, [5]) and keeps the
		// original value.
		decline("a model catalog maxOutput that isn't a number")
	}
	return out, true
}

// jsTruthy is a decoded JSON value's truthiness (numbers as json.Number).
func jsTruthy(v any) bool {
	switch t := v.(type) {
	case nil:
		return false
	case bool:
		return t
	case json.Number:
		n, err := strconv.ParseFloat(string(t), 64)
		return err != nil || n != 0
	case string:
		return t != ""
	}
	return true
}
