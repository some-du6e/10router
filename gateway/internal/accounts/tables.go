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
	"fmt"
	"regexp"
	"strings"
)

//go:embed tables.json
var tablesJSON []byte

type errorRule struct {
	Text       string  `json:"text"`
	Status     int     `json:"status"`
	CooldownMs float64 `json:"cooldownMs"`
	Backoff    bool    `json:"backoff"`
}

// jsRegex is a JavaScript regex as Node exported it: its source and flags.
type jsRegex struct {
	Source string `json:"source"`
	Flags  string `json:"flags"`
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
		DataURI          jsRegex  `json:"dataUri"`
		Base64SourceType string   `json:"base64SourceType"`
		MimeTypeKeys     []string `json:"mimeTypeKeys"`
		DataKey          string   `json:"dataKey"`
	} `json:"inlineMedia"`
	SessionHeaderKeys []string `json:"sessionHeaderKeys"`
	SameRequestError  struct {
		StopAfter     int       `json:"stopAfter"`
		Statuses      []int     `json:"statuses"`
		LimitPatterns []jsRegex `json:"limitPatterns"`
		ShapePatterns []jsRegex `json:"shapePatterns"`
		KeyLimit      jsRegex   `json:"keyLimit"`
		MaxText       int       `json:"maxText"`
	} `json:"sameRequestError"`
	ModelRefusal                   jsRegex           `json:"modelRefusal"`
	OperationRefusal               jsRegex           `json:"operationRefusal"`
	UpstreamStreamHeadersTimeoutMs float64           `json:"upstreamStreamHeadersTimeoutMs"`
	DefaultErrorMessages           map[string]string `json:"defaultErrorMessages"`
	ErrorTypes                     map[string]struct {
		Type string `json:"type"`
		Code string `json:"code"`
	} `json:"errorTypes"`
}

var (
	dataURIRe, claudeSessionRe, billingHeaderRe *regexp.Regexp
	sameLimitRes, sameShapeRes                  []*regexp.Regexp
	sameKeyLimitRe, keyRefusalRe                *regexp.Regexp
	requestErrorStatus                          = map[int]bool{}
	sameRequestStatus                           = map[int]bool{}
	affinityProvider                            = map[string]bool{}
)

func init() {
	if err := json.Unmarshal(tablesJSON, &tbl); err != nil {
		panic(fmt.Sprintf("accounts: tables.json: %v", err))
	}
	if len(tbl.ErrorRules) == 0 || tbl.HeadersTimeout.Text == "" || tbl.CacheAffinity.MaxWarmKeys == 0 {
		panic("accounts: tables.json is incomplete")
	}
	dataURIRe = compileJS(tbl.InlineMedia.DataURI)
	// Module-private constants in Node (sessionManager.js, claudeCloaking.js):
	// restated, and held to Node by the recorded cache-affinity keys.
	claudeSessionRe = compileJS(jsRegex{Source: `_session_([a-f0-9-]+)$`})
	billingHeaderRe = compileJS(jsRegex{Source: `^x-anthropic-billing-header:[^\n]*(?:\r?\n)?`, Flags: "i"})
	for _, p := range tbl.SameRequestError.LimitPatterns {
		sameLimitRes = append(sameLimitRes, compileJS(p))
	}
	for _, p := range tbl.SameRequestError.ShapePatterns {
		sameShapeRes = append(sameShapeRes, compileJS(p))
	}
	sameKeyLimitRe = compileJS(tbl.SameRequestError.KeyLimit)
	// KEY_REFUSAL: MODEL_REFUSAL and OPERATION_REFUSAL joined, case-insensitive.
	keyRefusalRe = compileJS(jsRegex{Source: tbl.ModelRefusal.Source + "|" + tbl.OperationRefusal.Source, Flags: "i"})
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

// jsSpaces is JavaScript's \s: WhiteSpace and LineTerminator.
const jsSpaces = `\t\n\x{0b}\f\r \x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}`

// compileJS compiles a JavaScript regex (no u flag) for Go's engine. The
// patterns Node exports use only what both engines read alike, with two
// differences the rewrite closes: JavaScript's `.` doesn't match \r,
// or   (Go's matches all but \n), and its /i compares ASCII letters
// case-blind where Go's (?i) also folds the Kelvin sign and the long s. So
// `.` becomes an explicit class and, under /i, every ASCII letter outside a
// class becomes [xX].
func compileJS(r jsRegex) *regexp.Regexp {
	for _, f := range r.Flags {
		if f != 'i' {
			panic(fmt.Sprintf("accounts: regex /%s/%s: flag %q not supported", r.Source, r.Flags, f))
		}
	}
	fold := strings.Contains(r.Flags, "i")
	var b strings.Builder
	src := r.Source
	inClass := false
	for i := 0; i < len(src); i++ {
		c := src[i]
		switch {
		case c == '\\' && i+1 < len(src) && (src[i+1] == 's' || src[i+1] == 'S'):
			// JavaScript's \s is Unicode whitespace; Go's is ASCII.
			switch {
			case src[i+1] == 's' && inClass:
				b.WriteString(jsSpaces)
			case src[i+1] == 's':
				b.WriteString("[" + jsSpaces + "]")
			case !inClass:
				b.WriteString("[^" + jsSpaces + "]")
			default:
				panic(fmt.Sprintf("accounts: regex /%s/: \\S inside a class", r.Source))
			}
			i++
		case c == '\\' && i+1 < len(src):
			b.WriteByte(c)
			i++
			b.WriteByte(src[i])
		case c == '[' && !inClass:
			inClass = true
			b.WriteByte(c)
		case c == ']' && inClass:
			inClass = false
			b.WriteByte(c)
		case c == '.' && !inClass:
			b.WriteString(`[^\n\r\x{2028}\x{2029}]`)
		case fold && !inClass && (c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z'):
			lower, upper := c|0x20, c&^0x20
			b.WriteString("[" + string(lower) + string(upper) + "]")
		case fold && inClass && (c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z'):
			// Inside a class both cases go in, so [a-z] under /i folds too.
			if i+2 < len(src) && src[i+1] == '-' && src[i+2] != ']' {
				lo, hi := c, src[i+2]
				b.WriteString(string(lo) + "-" + string(hi))
				if lo >= 'a' && hi <= 'z' {
					b.WriteString(string(lo&^0x20) + "-" + string(hi&^0x20))
				} else if lo >= 'A' && hi <= 'Z' {
					b.WriteString(string(lo|0x20) + "-" + string(hi|0x20))
				}
				i += 2
			} else {
				b.WriteString(string(c|0x20) + string(c&^0x20))
			}
		default:
			b.WriteByte(c)
		}
	}
	re, err := regexp.Compile(b.String())
	if err != nil {
		panic(fmt.Sprintf("accounts: regex /%s/%s: %v", r.Source, r.Flags, err))
	}
	return re
}
