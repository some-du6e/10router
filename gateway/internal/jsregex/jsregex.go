// Package jsregex compiles JavaScript regexes (no u flag) for Go's engine,
// for the patterns the gateway's ports take from Node's tables or restate.
package jsregex

import (
	"fmt"
	"regexp"
	"strings"
)

// Regex is a JavaScript regex as Node exports it: its source and flags.
type Regex struct {
	Source string `json:"source"`
	Flags  string `json:"flags"`
}

// spaces is JavaScript's \s: WhiteSpace and LineTerminator (jsjson.IsSpace).
const spaces = `\t\n\x{0b}\f\r \x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}`

// Compile compiles r. The patterns used take only what both engines read
// alike, with three differences the rewrite closes: JavaScript's `.` doesn't
// match \r, U+2028 or U+2029 (Go's matches all but \n); its \s is Unicode
// whitespace (Go's is ASCII); and its /i compares ASCII letters case-blind
// where Go's (?i) also folds the Kelvin sign and the long s. So `.` becomes
// an explicit class, \s and \S the JavaScript set, and under /i every ASCII
// letter both cases. Flags other than i are refused.
func Compile(r Regex) (*regexp.Regexp, error) {
	for _, f := range r.Flags {
		if f != 'i' {
			return nil, fmt.Errorf("jsregex: /%s/%s: flag %q not supported", r.Source, r.Flags, f)
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
			switch {
			case src[i+1] == 's' && inClass:
				b.WriteString(spaces)
			case src[i+1] == 's':
				b.WriteString("[" + spaces + "]")
			case !inClass:
				b.WriteString("[^" + spaces + "]")
			default:
				return nil, fmt.Errorf("jsregex: /%s/: \\S inside a class", r.Source)
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
			b.WriteString("[" + string(c|0x20) + string(c&^0x20) + "]")
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
		return nil, fmt.Errorf("jsregex: /%s/%s: %v", r.Source, r.Flags, err)
	}
	return re, nil
}
