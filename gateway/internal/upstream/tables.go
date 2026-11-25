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
	"fmt"

	"github.com/some-du6e/10router/gateway/internal/decline"
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

func init() {
	if err := json.Unmarshal(tablesJSON, &tbl); err != nil {
		panic(fmt.Sprintf("upstream: tables.json: %v", err))
	}
	if len(tbl.RetryConfig) == 0 || tbl.HeadersTimeoutText == "" || tbl.ProxyDirect == "" || tbl.Executor.FallbackCount == 0 {
		panic("upstream: tables.json is incomplete")
	}
	for _, t := range tbl.RelayTypes {
		relayType[t] = true
	}
}

func declined(format string, args ...any) error { return decline.New("upstream", format, args...) }
