// Package upstream sends what claudeprep built the way Node's DefaultExecutor
// and proxyAwareFetch send it (docs/GO_GATEWAY.md, phase 2c): the network
// route (proxy pools, Direct, the system proxy), Node fetch's wire defaults,
// the headers budget, the per-status retries, and the beta retries that re-run
// Prepare with the flags the endpoint named (open-sse/executors/base.js,
// open-sse/executors/default.js, open-sse/utils/proxyFetch.js,
// open-sse/utils/headersTimeout.js, src/lib/network/connectionProxy.ts,
// src/lib/network/proxyRouting.ts, open-sse/utils/anthropicBeta.ts).
//
// It serves only what it can send exactly as Node would. A proxy pool, a
// relay, a legacy per-account proxy, a system proxy that applies, an
// endpoint's Timeout, Retries or Proxy setting, and TLS settings Node reads
// from its environment are declines. A redirect, a 421, a network error and a
// response encoding other than gzip hand the request to Node, which has sent
// nothing to the client yet.
//
// The tables aren't restated: tables.json is exported from Node by
// tests/unit/gateway-upstream-parity.test.js, which fails when it is stale.
package upstream

import (
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"

	"github.com/some-du6e/10router/gateway/internal/decline"
	"github.com/some-du6e/10router/gateway/internal/jsregex"
)

//go:embed tables.json
var tablesJSON []byte

type retryRule struct {
	Attempts *float64 `json:"attempts"`
	DelayMs  *float64 `json:"delayMs"`
	// Number: a bare attempt count (resolveRetryEntry's number form).
	Number *float64 `json:"number"`
}

var tbl struct {
	// DefaultRetryConfig is DEFAULT_RETRY_CONFIG merged with the executor's
	// own retry config, by status.
	RetryConfig map[string]retryRule `json:"retryConfig"`
	// RetryDelayMs is RETRY_CONFIG.delayMs, resolveRetryEntry's default delay.
	RetryDelayMs float64 `json:"retryDelayMs"`
	// Executor is DefaultExecutor's config for a custom node (PROVIDERS.openai).
	Executor struct {
		TimeoutMs              float64 `json:"timeoutMs"`
		HeadersTimeoutAttempts float64 `json:"headersTimeoutAttempts"`
		FallbackCount          int     `json:"fallbackCount"`
	} `json:"executor"`
	FetchConnectTimeoutMs  float64  `json:"fetchConnectTimeoutMs"`
	HeadersTimeoutAttempts float64  `json:"headersTimeoutAttempts"`
	MaxTimerMs             float64  `json:"maxTimerMs"`
	HeadersTimeoutText     string   `json:"headersTimeoutText"`
	BetaHeaderKeys         []string `json:"betaHeaderKeys"`
	ProxyDirect            string   `json:"proxyDirect"`
	RelayTypes             []string `json:"relayTypes"`
}

var relayType = map[string]bool{}

// loadErr is why the embedded tables can't be used (nil when they can).
var loadErr error

// Ready reports whether the embedded tables loaded. The native route stays
// off when they didn't: a bad embed must not crash a gateway that only
// relays.
func Ready() error { return loadErr }

// never matches nothing: a pattern that failed to compile stands in as it.
var never = regexp.MustCompile(`[^\x00-\x{10FFFF}]`)

// compile is jsregex.Compile, with a failure kept in loadErr.
func compile(r jsregex.Regex) *regexp.Regexp {
	re, err := jsregex.Compile(r)
	if err != nil {
		loadErr = errors.Join(loadErr, fmt.Errorf("upstream: %w", err))
		return never
	}
	return re
}

func init() {
	if err := json.Unmarshal(tablesJSON, &tbl); err != nil {
		loadErr = errors.Join(loadErr, fmt.Errorf("upstream: tables.json: %w", err))
		return
	}
	if len(tbl.RetryConfig) == 0 || tbl.HeadersTimeoutText == "" || tbl.ProxyDirect == "" || tbl.Executor.FallbackCount <= 0 ||
		tbl.MaxTimerMs <= 0 || tbl.FetchConnectTimeoutMs <= 0 || tbl.HeadersTimeoutAttempts <= 0 || len(tbl.BetaHeaderKeys) == 0 {
		loadErr = errors.Join(loadErr, errors.New("upstream: tables.json is incomplete"))
		return
	}
	for _, t := range tbl.RelayTypes {
		relayType[t] = true
	}
}

func declined(format string, args ...any) error { return decline.New("upstream", format, args...) }
