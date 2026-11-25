package accounts

import (
	"fmt"
	"math"
	"strings"
	"time"
)

// Fallback is checkFallbackError's result. NewBackoffLevel is set (Has) only
// by a backoff rule.
type Fallback struct {
	ShouldFallback  bool
	CooldownMs      float64
	NewBackoffLevel int
	HasBackoffLevel bool
}

// QuotaCooldown is getQuotaCooldown: 2s, 4s, 8s... up to the maximum.
func QuotaCooldown(backoffLevel int) float64 {
	level := math.Max(0, float64(backoffLevel-1))
	return math.Min(tbl.Backoff.Base*math.Pow(2, level), tbl.Backoff.Max)
}

// CheckFallbackError is accountFallback.js's checkFallbackError: ERROR_RULES
// top to bottom, text rules on the lowercased error, then status rules, else
// the transient cooldown. errorText is the error as Node holds it, a string.
func CheckFallbackError(status int, errorText string, backoffLevel int) Fallback {
	lower := jsLowerASCIIOnly(errorText)
	for _, r := range tbl.ErrorRules {
		match := (r.Text != "" && lower != "" && strings.Contains(lower, r.Text)) || (r.Text == "" && r.Status != 0 && r.Status == status)
		if !match {
			continue
		}
		if r.Backoff {
			level := int(math.Min(float64(backoffLevel+1), tbl.Backoff.MaxLevel))
			return Fallback{ShouldFallback: true, CooldownMs: QuotaCooldown(level), NewBackoffLevel: level, HasBackoffLevel: true}
		}
		return Fallback{ShouldFallback: true, CooldownMs: r.CooldownMs}
	}
	return Fallback{ShouldFallback: true, CooldownMs: tbl.TransientCooldownMs}
}

// jsLowerASCIIOnly lowercases for the substring rules, which are ASCII: a
// non-ASCII letter whose lowercase is ASCII under JavaScript's rules (the
// Kelvin sign is k, a dotted capital I is i plus a combining dot) is the one
// way the two languages could disagree, so those are lowered as JavaScript
// lowers them and everything else non-ASCII is left alone (no rule names it).
func jsLowerASCIIOnly(s string) string {
	var b strings.Builder
	b.Grow(len(s))
	for _, r := range s {
		switch {
		case r >= 'A' && r <= 'Z':
			b.WriteRune(r + 32)
		case r == 'K': // KELVIN SIGN
			b.WriteByte('k')
		case r == 0x130: // LATIN CAPITAL LETTER I WITH DOT ABOVE
			b.WriteString("i\xcc\x87") // i, U+0307 COMBINING DOT ABOVE
		default:
			b.WriteRune(r)
		}
	}
	return b.String()
}

// ContainsFold is text.toLowerCase().includes(needle) for a lowercase ASCII
// needle.
func ContainsFold(text, needle string) bool {
	return strings.Contains(jsLowerASCIIOnly(text), needle)
}

// IsLimitError is limitHold.js's isLimitError.
func IsLimitError(status int, errorText string) bool {
	if status == 429 {
		return true
	}
	lower := jsLowerASCIIOnly(errorText)
	for _, t := range tbl.LimitErrorTexts {
		if strings.Contains(lower, t) {
			return true
		}
	}
	return false
}

// NamesAccountOrLimit is accountFallback.js's namesAccountOrLimit.
func NamesAccountOrLimit(errorText string) bool {
	lower := jsLowerASCIIOnly(errorText)
	for _, lists := range [][]string{tbl.BadKeyTexts, tbl.BillingTexts} {
		for _, t := range lists {
			if strings.Contains(lower, t) {
				return true
			}
		}
	}
	for _, r := range tbl.ErrorRules {
		if r.Text != "" && strings.Contains(lower, r.Text) {
			return true
		}
	}
	return false
}

// IsRequestError is isRequestError: a 400, 404 or 422 that isn't about the
// key or a limit.
func IsRequestError(status int, errorText string) bool {
	return requestErrorStatus[status] && !NamesAccountOrLimit(errorText)
}

// IsHeadersTimeout is isHeadersTimeout: a 504 with the header-timeout text.
func IsHeadersTimeout(status int, errorText string) bool {
	return status == 504 && strings.Contains(errorText, tbl.HeadersTimeout.Text)
}

// HeadersTimeoutText is HEADERS_TIMEOUT.text.
func HeadersTimeoutText() string { return tbl.HeadersTimeout.Text }

// Lock field names (accountFallback.js, auth.js, accountFailureSummary.js).
const (
	ModelLockPrefix     = "modelLock_"
	ModelLockAll        = ModelLockPrefix + "__all"
	modelLimitPrefix    = "modelLimit_"
	noHeadersPrefix     = "modelNoHeaders_"
	providerResetPrefix = "providerReset_"
)

// ModelLockKey is getModelLockKey.
func ModelLockKey(model string) string {
	if model == "" {
		return ModelLockAll
	}
	return ModelLockPrefix + model
}

// ModelIDProblem is modelPath.ts's modelIdProblem(model) != null: an id no
// upstream may be asked for, which Node refuses with a 400 before any
// account is tried. A lock name (`__all`, `websearch:…`, `webfetch:…`), and
// an id that is empty, "." or "..", plainly or percent-encoded.
func ModelIDProblem(model string) bool {
	if ModelLockKey(model) == ModelLockAll || strings.HasPrefix(model, "websearch:") || strings.HasPrefix(model, "webfetch:") {
		return true
	}
	if model == "" || model == "." || model == ".." {
		return true
	}
	// decodeURIComponent turns the id into "." or ".." only when it is dots
	// and %2e escapes; any other escape decodes to something else, and a bad
	// one makes Node keep the id as it is.
	decoded := strings.NewReplacer("%2e", ".", "%2E", ".").Replace(model)
	return decoded == "." || decoded == ".."
}

// scope is the lock scope a model writes under: the model, or "__all".
func scope(model string) string {
	if model == "" {
		return "__all"
	}
	return model
}

// FormatRetryAfter is formatRetryAfter for a time in ms.
func FormatRetryAfter(untilMs, nowMs float64) string {
	diff := untilMs - nowMs
	if diff <= 0 {
		return "reset after 0s"
	}
	total := int64(math.Ceil(diff / 1000))
	h, m, s := total/3600, (total%3600)/60, total%60
	var parts []string
	if h > 0 {
		parts = append(parts, fmt.Sprintf("%dh", h))
	}
	if m > 0 {
		parts = append(parts, fmt.Sprintf("%dm", m))
	}
	if s > 0 || len(parts) == 0 {
		parts = append(parts, fmt.Sprintf("%ds", s))
	}
	return "reset after " + strings.Join(parts, " ")
}

// isoMs is `new Date(ms).toISOString()`.
func isoMs(ms float64) string {
	return time.UnixMilli(int64(ms)).UTC().Format("2006-01-02T15:04:05.000Z")
}
