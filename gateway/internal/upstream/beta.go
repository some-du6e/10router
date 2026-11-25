package upstream

import (
	"regexp"
	"strings"

	"github.com/some-du6e/10router/gateway/internal/claudeprep"
)

// maxBetaRetries is default.js's MAX_BETA_RETRIES (module-private; held to
// Node by the recorded beta scenarios).
const maxBetaRetries = 1

// rejectedRe is anthropicBeta.ts's REJECTED_RE, /Unexpected
// value\(s\)\s+(.+?)\s+for the\s+`?anthropic-beta`?\s+header/i, with the
// letters spelled out (Go's (?i) folds the Kelvin sign and the long s, and
// JavaScript's /i without u doesn't) and \s as JavaScript's. Module-private
// in Node; held to it by the recorded rejection texts.
var rejectedRe = func() *regexp.Regexp {
	ws := "[" + regexp.QuoteMeta(jsWhitespace) + "]"
	fold := func(s string) string {
		var b strings.Builder
		for _, c := range s {
			switch {
			case c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z':
				b.WriteString("[" + strings.ToLower(string(c)) + strings.ToUpper(string(c)) + "]")
			case c == ' ':
				b.WriteString(" ")
			default:
				b.WriteString(regexp.QuoteMeta(string(c)))
			}
		}
		return b.String()
	}
	// JavaScript's `.` stops at \n, \r and the line separators.
	dot := `[^\n\r\x{2028}\x{2029}]`
	src := fold("Unexpected value") + `\(` + fold("s") + `\)` + ws + `+(` + dot + `+?)` + ws + `+` + fold("for the") + ws + "+`?" + fold("anthropic-beta") + "`?" + ws + `+` + fold("header")
	return regexp.MustCompile(src)
}()

var backtickRe = regexp.MustCompile("`([^`]+)`")

// parseRejectedBetas is anthropicBeta.ts's: the flags a 400 body names in
// backticks as rejected, or none.
func parseRejectedBetas(text string) []string {
	m := rejectedRe.FindStringSubmatch(text)
	if m == nil {
		return nil
	}
	var out []string
	for _, x := range backtickRe.FindAllStringSubmatch(m[1], -1) {
		if f := jsTrim(x[1]); f != "" {
			out = append(out, f)
		}
	}
	return out
}

// sentBetas is anthropicBeta.ts's: the flags in every header named
// anthropic-beta, any case.
func sentBetas(h []claudeprep.HeaderField) map[string]bool {
	flags := map[string]bool{}
	for _, f := range h {
		if strings.ToLower(f.Name) == tbl.BetaHeaderKeys[0] {
			for _, s := range strings.Split(f.Value, ",") {
				if s = jsTrim(s); s != "" {
					flags[s] = true
				}
			}
		}
	}
	return flags
}

// appendUnique is [...new Set([...a, ...b])].
func appendUnique(a []string, b ...string) []string {
	seen := map[string]bool{}
	out := make([]string, 0, len(a)+len(b))
	for _, s := range append(append([]string(nil), a...), b...) {
		if !seen[s] {
			seen[s] = true
			out = append(out, s)
		}
	}
	return out
}
