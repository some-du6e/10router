package upstream

import (
	"fmt"
	"math"

	"github.com/some-du6e/10router/gateway/internal/db/jsjson"
)

// Env reads the process environment (os.Getenv).
type Env func(string) string

var jsTrim = jsjson.Trim

// jsParseInt is parseInt(raw, 10): leading whitespace, a sign, then digits up
// to the first non-digit; ok is false for NaN.
func jsParseInt(raw string) (float64, bool) {
	s := jsjson.TrimLeft(raw)
	neg := false
	if s != "" && (s[0] == '+' || s[0] == '-') {
		neg = s[0] == '-'
		s = s[1:]
	}
	n, digits := 0.0, 0
	for digits < len(s) && s[digits] >= '0' && s[digits] <= '9' {
		n = n*10 + float64(s[digits]-'0')
		digits++
	}
	if digits == 0 {
		return 0, false
	}
	if neg {
		n = -n
	}
	return n, true
}

// envMs is runtimeConfig.js's envMs: an integer override in min..MAX_TIMER_MS,
// else def.
func envMs(env Env, name string, def, min float64) float64 {
	raw := env(name)
	if raw == "" {
		return def
	}
	n, ok := jsParseInt(raw)
	if ok && n >= min && n <= tbl.MaxTimerMs {
		return n
	}
	return def
}

// Budget is upstreamHeadersBudget for the executor's config: how long one
// URL waits for response headers, and the setting that chose it.
type Budget struct {
	Ms    float64
	SetBy string
}

// HeadersBudget is upstreamHeadersBudget({stream, timeoutMs, attempts}) with
// DefaultExecutor's config and the environment's overrides.
func HeadersBudget(env Env, stream bool) Budget {
	connect := envMs(env, "FETCH_CONNECT_TIMEOUT_MS", tbl.FetchConnectTimeoutMs, 1)
	timeout, attempts := tbl.Executor.TimeoutMs, tbl.Executor.HeadersTimeoutAttempts
	if timeout > 0 || attempts > 0 {
		n := tbl.HeadersTimeoutAttempts
		if attempts > 0 {
			n = attempts
		}
		per, what := connect, "FETCH_CONNECT_TIMEOUT_MS"
		if timeout > 0 {
			per, what = timeout, "the endpoint's Timeout setting"
		}
		setBy := what
		if n != 1 {
			setBy = jsNum(n) + "x " + what
		}
		return Budget{Ms: math.Min(n*per, tbl.MaxTimerMs), SetBy: setBy}
	}
	all := math.Min(tbl.HeadersTimeoutAttempts*connect, tbl.MaxTimerMs)
	if stream {
		return Budget{Ms: envMs(env, "UPSTREAM_STREAM_HEADERS_TIMEOUT_MS", all, 1), SetBy: "UPSTREAM_STREAM_HEADERS_TIMEOUT_MS"}
	}
	return Budget{Ms: all, SetBy: jsNum(tbl.HeadersTimeoutAttempts) + "x FETCH_CONNECT_TIMEOUT_MS"}
}

// jsNum is a number as a template literal writes it.
func jsNum(f float64) string { return string(jsjson.AppendNumber(nil, f)) }

// TimeoutText is UpstreamHeadersTimeoutError's message for the budget:
// Math.round(ms / 1000) seconds.
func (b Budget) TimeoutText() string {
	setBy := ""
	if b.SetBy != "" {
		setBy = ", set by " + b.SetBy
	}
	return fmt.Sprintf("%s in %ss (headers timeout%s)", tbl.HeadersTimeoutText, jsNum(math.Floor(b.Ms/1000+0.5)), setBy)
}
