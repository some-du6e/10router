package jsjson

import (
	"strings"
	"unicode/utf8"
)

// IsSpace is JavaScript's WhiteSpace and LineTerminator: what String#trim,
// parseInt and the regex \s skip.
func IsSpace(r rune) bool {
	switch r {
	case 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0xa0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff:
		return true
	}
	return r >= 0x2000 && r <= 0x200a
}

// Trim is String#trim.
func Trim(s string) string { return strings.TrimFunc(s, IsSpace) }

// TrimLeft is String#trimStart.
func TrimLeft(s string) string { return strings.TrimLeftFunc(s, IsSpace) }

// UTF16Len is String#length for a string held as WTF-8: a lone surrogate
// half (ED A0..BF xx) is one code unit, a supplementary character two.
func UTF16Len(s string) int {
	n := 0
	for i := 0; i < len(s); {
		if s[i] == 0xED && i+2 < len(s) && s[i+1] >= 0xA0 && s[i+1] <= 0xBF {
			n++
			i += 3
			continue
		}
		r, size := utf8.DecodeRuneInString(s[i:])
		if r > 0xFFFF {
			n += 2
		} else {
			n++
		}
		i += size
	}
	return n
}

// Or is `a || b`: a when it is truthy.
func Or(a, b any) any {
	if Truthy(a) {
		return a
	}
	return b
}
