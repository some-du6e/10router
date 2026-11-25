// Package accounts picks the provider connection (key) a native request
// uses and keeps the per-key state Node keeps (docs/GO_GATEWAY.md, phase 2c):
// connection listing and filtering, the fill-first and round-robin strategies
// with stickiness, prompt-cache warm keys and the wait for one, the locks and
// exponential backoff of ERROR_RULES, lock clearing on success, the
// header-timeout and same-request-error stops, and model hang
// (src/sse/services/auth.js, open-sse/services/accountFallback.js,
// open-sse/config/errorConfig.js, open-sse/services/cacheAffinity.js,
// open-sse/services/modelHang.js, open-sse/services/sameRequestError.ts, the
// account loop in src/sse/handlers/chat.ts).
//
// What it doesn't model it declines, so the request goes to Node: keys with
// demotion records (dead-key evidence lives in Node's memory), a 401 or 403
// before any byte went to the client, the soonest-reset strategy, and every
// provider but an openai-compatible node.
//
// The rule tables aren't restated: tables.json is exported from Node by
// tests/unit/gateway-accounts-parity.test.js, which fails when it is stale.
package accounts

import (
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"

	"github.com/some-du6e/10router/gateway/internal/jsregex"
)

//go:embed tables.json
var tablesJSON []byte

type errorRule struct {
	Text       string  `json:"text"`
	Status     int     `json:"status"`
	CooldownMs float64 `json:"cooldownMs"`
	Backoff    bool    `json:"backoff"`
}

var tbl struct {
	ErrorRules             []errorRule                           `json:"errorRules"`
	Backoff                struct{ Base, Max, MaxLevel float64 } `json:"backoff"`
	TransientCooldownMs    float64                               `json:"transientCooldownMs"`
	MaxRateLimitCooldownMs float64                               `json:"maxRateLimitCooldownMs"`
	BadKeyTexts            []string                              `json:"badKeyTexts"`
	BillingTexts           []string                              `json:"billingTexts"`
	LimitErrorTexts        []string                              `json:"limitErrorTexts"`
	RequestErrorStatuses   []int                                 `json:"requestErrorStatuses"`
	HeadersTimeout         struct {
		Text               string    `json:"text"`
		MaxKeysPerRequest  int       `json:"maxKeysPerRequest"`
		HungAfterRequests  int       `json:"hungAfterRequests"`
		HungAfterKeys      int       `json:"hungAfterKeys"`
		HungWindowMs       []float64 `json:"hungWindowMs"`
		ResetAfterMs       float64   `json:"resetAfterMs"`
		ProbeLeaseMs       float64   `json:"probeLeaseMs"`
		ProbeLeaseMarginMs float64   `json:"probeLeaseMarginMs"`
	} `json:"headersTimeout"`
	CacheAffinity struct {
		TTLMs           float64 `json:"ttlMs"`
		LongTTLMs       float64 `json:"longTtlMs"`
		MaxWaitMs       float64 `json:"maxWaitMs"`
		MinPromptTokens float64 `json:"minPromptTokens"`
		MaxEntries      int     `json:"maxEntries"`
		MaxWarmKeys     int     `json:"maxWarmKeys"`
		LockSlackMs     float64 `json:"lockSlackMs"`
		JitterMs        float64 `json:"jitterMs"`
	} `json:"cacheAffinity"`
	AffinityProviders []string `json:"affinityProviders"`
	InlineMedia       struct {
		DataURI          jsregex.Regex `json:"dataUri"`
		Base64SourceType string        `json:"base64SourceType"`
		MimeTypeKeys     []string      `json:"mimeTypeKeys"`
		DataKey          string        `json:"dataKey"`
	} `json:"inlineMedia"`
	SessionHeaderKeys []string `json:"sessionHeaderKeys"`
	SameRequestError  struct {
		StopAfter     int             `json:"stopAfter"`
		Statuses      []int           `json:"statuses"`
		LimitPatterns []jsregex.Regex `json:"limitPatterns"`
		ShapePatterns []jsregex.Regex `json:"shapePatterns"`
		KeyLimit      jsregex.Regex   `json:"keyLimit"`
		MaxText       int             `json:"maxText"`
	} `json:"sameRequestError"`
	ModelRefusal                   jsregex.Regex     `json:"modelRefusal"`
	OperationRefusal               jsregex.Regex     `json:"operationRefusal"`
	UpstreamStreamHeadersTimeoutMs float64           `json:"upstreamStreamHeadersTimeoutMs"`
	DefaultErrorMessages           map[string]string `json:"defaultErrorMessages"`
	ErrorTypes                     map[string]struct {
		Type string `json:"type"`
		Code string `json:"code"`
	} `json:"errorTypes"`
}

// The regexes start as never, so a table that didn't load leaves nothing nil
// for a caller that didn't check Ready.
var (
	dataURIRe, claudeSessionRe, billingHeaderRe = never, never, never
	sameLimitRes, sameShapeRes                  []*regexp.Regexp
	sameKeyLimitRe, keyRefusalRe                = never, never
	requestErrorStatus                          = map[int]bool{}
	sameRequestStatus                           = map[int]bool{}
	affinityProvider                            = map[string]bool{}
)

// loadErr is why the embedded tables can't be used (nil when they can).
var loadErr error

// Ready reports whether the embedded tables loaded. The native route stays
// off when they didn't, as it does for an unreadable node-map.json: a bad
// embed must not crash a gateway that only relays.
func Ready() error { return loadErr }

// never matches nothing: a pattern that failed to compile stands in as it.
var never = regexp.MustCompile(`[^\x00-\x{10FFFF}]`)

// compile is jsregex.Compile, with a failure kept in loadErr.
func compile(r jsregex.Regex) *regexp.Regexp {
	re, err := jsregex.Compile(r)
	if err != nil {
		loadErr = errors.Join(loadErr, fmt.Errorf("accounts: %w", err))
		return never
	}
	return re
}

func init() {
	if err := json.Unmarshal(tablesJSON, &tbl); err != nil {
		loadErr = errors.Join(loadErr, fmt.Errorf("accounts: tables.json: %w", err))
		return
	}
	h, c := tbl.HeadersTimeout, tbl.CacheAffinity
	if len(tbl.ErrorRules) == 0 || h.Text == "" || len(h.HungWindowMs) == 0 || h.MaxKeysPerRequest <= 0 ||
		h.HungAfterRequests <= 0 || h.HungAfterKeys <= 0 || c.MaxWarmKeys <= 0 || c.MaxEntries <= 0 ||
		tbl.SameRequestError.StopAfter <= 0 || tbl.SameRequestError.MaxText <= 0 || tbl.Backoff.Base <= 0 ||
		tbl.Backoff.Max <= 0 || tbl.MaxRateLimitCooldownMs <= 0 || tbl.UpstreamStreamHeadersTimeoutMs <= 0 {
		loadErr = errors.Join(loadErr, errors.New("accounts: tables.json is incomplete"))
		return
	}
	dataURIRe = compile(tbl.InlineMedia.DataURI)
	// Module-private constants in Node (sessionManager.js, claudeCloaking.js):
	// restated, and held to Node by the recorded cache-affinity keys.
	claudeSessionRe = compile(jsregex.Regex{Source: `_session_([a-f0-9-]+)$`})
	billingHeaderRe = compile(jsregex.Regex{Source: `^x-anthropic-billing-header:[^\n]*(?:\r?\n)?`, Flags: "i"})
	for _, p := range tbl.SameRequestError.LimitPatterns {
		sameLimitRes = append(sameLimitRes, compile(p))
	}
	for _, p := range tbl.SameRequestError.ShapePatterns {
		sameShapeRes = append(sameShapeRes, compile(p))
	}
	sameKeyLimitRe = compile(tbl.SameRequestError.KeyLimit)
	// KEY_REFUSAL: MODEL_REFUSAL and OPERATION_REFUSAL joined, case-insensitive.
	keyRefusalRe = compile(jsregex.Regex{Source: tbl.ModelRefusal.Source + "|" + tbl.OperationRefusal.Source, Flags: "i"})
	for _, s := range tbl.RequestErrorStatuses {
		requestErrorStatus[s] = true
	}
	for _, s := range tbl.SameRequestError.Statuses {
		sameRequestStatus[s] = true
	}
	for _, p := range tbl.AffinityProviders {
		affinityProvider[p] = true
	}
}
