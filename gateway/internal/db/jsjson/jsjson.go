// Package jsjson reads and writes JSON the way JavaScript's JSON.parse and
// JSON.stringify do, so a row the gateway rewrites is the text Node would have
// written: object keys keep their order (array-index keys first, ascending, as
// V8 orders them), numbers are float64 printed as Number#toString prints them,
// and strings are escaped as JSON.stringify escapes them (no HTML escaping,
// no U+2028/U+2029 escaping).
//
// Values are nil (null), bool, float64, string, []any and *Object. A string
// may hold a lone surrogate as WTF-8 bytes (see Parse).
package jsjson

import (
	"bytes"
	"errors"
	"fmt"
	"math"
	"strconv"
	"unicode/utf8"
)

// Member is one key and its value.
type Member struct {
	Key   string
	Value any
}

// Object is a JSON object in JavaScript property order.
type Object struct {
	members []Member
}

// NewObject returns an empty object.
func NewObject() *Object { return &Object{} }

// Len is the number of keys.
func (o *Object) Len() int {
	if o == nil {
		return 0
	}
	return len(o.members)
}

// Members returns the keys and values in order. The slice must not be changed.
func (o *Object) Members() []Member {
	if o == nil {
		return nil
	}
	return o.members
}

// Keys returns the keys in order.
func (o *Object) Keys() []string {
	keys := make([]string, 0, o.Len())
	for _, m := range o.Members() {
		keys = append(keys, m.Key)
	}
	return keys
}

func (o *Object) index(key string) int {
	if o == nil {
		return -1
	}
	for i := range o.members {
		if o.members[i].Key == key {
			return i
		}
	}
	return -1
}

// Get returns the value at key. ok is false for a missing key; a present null
// is (nil, true).
func (o *Object) Get(key string) (value any, ok bool) {
	i := o.index(key)
	if i < 0 {
		return nil, false
	}
	return o.members[i].Value, true
}

// Has reports whether key is present.
func (o *Object) Has(key string) bool { return o.index(key) >= 0 }

// Set assigns key as JavaScript assignment does: an existing key keeps its
// place; a new array-index key goes among the leading index keys in ascending
// order; any other new key goes last.
func (o *Object) Set(key string, value any) {
	if i := o.index(key); i >= 0 {
		o.members[i].Value = value
		return
	}
	if idx, ok := arrayIndex(key); ok {
		at := 0
		for at < len(o.members) {
			other, isIdx := arrayIndex(o.members[at].Key)
			if !isIdx || other > idx {
				break
			}
			at++
		}
		o.members = append(o.members, Member{})
		copy(o.members[at+1:], o.members[at:])
		o.members[at] = Member{Key: key, Value: value}
		return
	}
	o.members = append(o.members, Member{Key: key, Value: value})
}

// Delete removes key, as the delete operator does.
func (o *Object) Delete(key string) {
	if i := o.index(key); i >= 0 {
		o.members = append(o.members[:i], o.members[i+1:]...)
	}
}

// Clone is a deep copy.
func (o *Object) Clone() *Object {
	if o == nil {
		return nil
	}
	c := &Object{members: make([]Member, len(o.members))}
	for i, m := range o.members {
		c.members[i] = Member{Key: m.Key, Value: CloneValue(m.Value)}
	}
	return c
}

// CloneValue deep-copies a value.
func CloneValue(v any) any {
	switch t := v.(type) {
	case *Object:
		return t.Clone()
	case []any:
		c := make([]any, len(t))
		for i := range t {
			c[i] = CloneValue(t[i])
		}
		return c
	}
	return v
}

// arrayIndex reports whether key is a canonical array index (0 to 2^32-2),
// the keys V8 lists first.
func arrayIndex(key string) (uint64, bool) {
	if key == "" || len(key) > 10 || (len(key) > 1 && key[0] == '0') {
		return 0, false
	}
	var n uint64
	for i := 0; i < len(key); i++ {
		c := key[i]
		if c < '0' || c > '9' {
			return 0, false
		}
		n = n*10 + uint64(c-'0')
	}
	return n, n < math.MaxUint32
}

// String is the object's JSON.
func (o *Object) String() string { return string(Marshal(o)) }

// ErrNotObject is returned by ParseObject for valid JSON that isn't an object.
var ErrNotObject = errors.New("jsjson: not an object")

// Parse reads one JSON value as JSON.parse would. A duplicate key keeps its
// first position and its last value. A \u escape of a lone surrogate, which
// a JavaScript string can hold (a string cut in the middle of an emoji), is
// kept as its WTF-8 bytes, which AppendString writes back as the same escape.
func Parse(data []byte) (any, error) {
	p := parser{data: data}
	v, err := p.value(0)
	if err != nil {
		return nil, err
	}
	p.space()
	if p.i != len(p.data) {
		return nil, p.fail("trailing data")
	}
	return v, nil
}

// ParseObject parses data that must be an object.
func ParseObject(data []byte) (*Object, error) {
	v, err := Parse(data)
	if err != nil {
		return nil, err
	}
	o, ok := v.(*Object)
	if !ok {
		return nil, ErrNotObject
	}
	return o, nil
}

// maxDepth bounds nesting, as V8's stack does.
const maxDepth = 10000

type parser struct {
	data []byte
	i    int
}

func (p *parser) fail(what string) error {
	return fmt.Errorf("jsjson: %s at offset %d", what, p.i)
}

func (p *parser) space() {
	for p.i < len(p.data) {
		switch p.data[p.i] {
		case ' ', '\t', '\n', '\r':
			p.i++
		default:
			return
		}
	}
}

func (p *parser) literal(word string, v any) (any, error) {
	if !bytes.HasPrefix(p.data[p.i:], []byte(word)) {
		return nil, p.fail("invalid literal")
	}
	p.i += len(word)
	return v, nil
}

func (p *parser) value(depth int) (any, error) {
	if depth > maxDepth {
		return nil, p.fail("nested too deep")
	}
	p.space()
	if p.i >= len(p.data) {
		return nil, p.fail("unexpected end")
	}
	switch c := p.data[p.i]; {
	case c == '{':
		p.i++
		o := &Object{}
		p.space()
		if p.i < len(p.data) && p.data[p.i] == '}' {
			p.i++
			return o, nil
		}
		for {
			p.space()
			if p.i >= len(p.data) || p.data[p.i] != '"' {
				return nil, p.fail("expected a key")
			}
			key, err := p.str()
			if err != nil {
				return nil, err
			}
			p.space()
			if p.i >= len(p.data) || p.data[p.i] != ':' {
				return nil, p.fail("expected ':'")
			}
			p.i++
			v, err := p.value(depth + 1)
			if err != nil {
				return nil, err
			}
			o.Set(key, v)
			p.space()
			if p.i < len(p.data) && p.data[p.i] == ',' {
				p.i++
				continue
			}
			if p.i < len(p.data) && p.data[p.i] == '}' {
				p.i++
				return o, nil
			}
			return nil, p.fail("expected ',' or '}'")
		}
	case c == '[':
		p.i++
		arr := []any{}
		p.space()
		if p.i < len(p.data) && p.data[p.i] == ']' {
			p.i++
			return arr, nil
		}
		for {
			v, err := p.value(depth + 1)
			if err != nil {
				return nil, err
			}
			arr = append(arr, v)
			p.space()
			if p.i < len(p.data) && p.data[p.i] == ',' {
				p.i++
				continue
			}
			if p.i < len(p.data) && p.data[p.i] == ']' {
				p.i++
				return arr, nil
			}
			return nil, p.fail("expected ',' or ']'")
		}
	case c == '"':
		return p.str()
	case c == 't':
		return p.literal("true", true)
	case c == 'f':
		return p.literal("false", false)
	case c == 'n':
		return p.literal("null", nil)
	case c == '-' || (c >= '0' && c <= '9'):
		return p.number()
	}
	return nil, p.fail("unexpected character")
}

// number reads JSON's number grammar. JSON.parse rounds to the nearest
// double, as ParseFloat does; past the double range it is ±Infinity.
func (p *parser) number() (any, error) {
	start := p.i
	digits := func() int {
		n := 0
		for p.i < len(p.data) && p.data[p.i] >= '0' && p.data[p.i] <= '9' {
			p.i++
			n++
		}
		return n
	}
	if p.data[p.i] == '-' {
		p.i++
	}
	if p.i < len(p.data) && p.data[p.i] == '0' {
		p.i++
	} else if digits() == 0 {
		return nil, p.fail("invalid number")
	}
	if p.i < len(p.data) && p.data[p.i] == '.' {
		p.i++
		if digits() == 0 {
			return nil, p.fail("invalid number")
		}
	}
	if p.i < len(p.data) && (p.data[p.i] == 'e' || p.data[p.i] == 'E') {
		p.i++
		if p.i < len(p.data) && (p.data[p.i] == '+' || p.data[p.i] == '-') {
			p.i++
		}
		if digits() == 0 {
			return nil, p.fail("invalid number")
		}
	}
	f, err := strconv.ParseFloat(string(p.data[start:p.i]), 64)
	if err != nil {
		var ne *strconv.NumError
		if !errors.As(err, &ne) || !errors.Is(ne.Err, strconv.ErrRange) {
			return nil, err
		}
	}
	return f, nil
}

func hexValue(b []byte) (rune, bool) {
	var r rune
	for _, c := range b {
		switch {
		case c >= '0' && c <= '9':
			r = r<<4 | rune(c-'0')
		case c >= 'a' && c <= 'f':
			r = r<<4 | rune(c-'a'+10)
		case c >= 'A' && c <= 'F':
			r = r<<4 | rune(c-'A'+10)
		default:
			return 0, false
		}
	}
	return r, true
}

// appendWTF8 appends r, which may be a lone surrogate, in WTF-8: UTF-8's
// encoding applied to the surrogate's code point.
func appendWTF8(b []byte, r rune) []byte {
	if r >= 0xD800 && r <= 0xDFFF {
		return append(b, 0xED, byte(0x80|(r>>6)&0x3F), byte(0x80|r&0x3F))
	}
	return utf8.AppendRune(b, r)
}

func (p *parser) str() (string, error) {
	p.i++ // the opening quote
	var out []byte
	start := p.i
	for p.i < len(p.data) {
		c := p.data[p.i]
		switch {
		case c == '"':
			if out == nil {
				s := string(p.data[start:p.i])
				p.i++
				return s, nil
			}
			out = append(out, p.data[start:p.i]...)
			p.i++
			return string(out), nil
		case c < 0x20:
			return "", p.fail("control character in a string")
		case c == '\\':
			out = append(out, p.data[start:p.i]...)
			if p.i+1 >= len(p.data) {
				return "", p.fail("unexpected end")
			}
			esc := p.data[p.i+1]
			p.i += 2
			switch esc {
			case '"', '\\', '/':
				out = append(out, esc)
			case 'b':
				out = append(out, '\b')
			case 'f':
				out = append(out, '\f')
			case 'n':
				out = append(out, '\n')
			case 'r':
				out = append(out, '\r')
			case 't':
				out = append(out, '\t')
			case 'u':
				if p.i+4 > len(p.data) {
					return "", p.fail("short \\u escape")
				}
				r, ok := hexValue(p.data[p.i : p.i+4])
				if !ok {
					return "", p.fail("invalid \\u escape")
				}
				p.i += 4
				// A high surrogate followed by an escaped low one is one code point.
				if r >= 0xD800 && r <= 0xDBFF && p.i+6 <= len(p.data) && p.data[p.i] == '\\' && p.data[p.i+1] == 'u' {
					if lo, ok := hexValue(p.data[p.i+2 : p.i+6]); ok && lo >= 0xDC00 && lo <= 0xDFFF {
						r = 0x10000 + (r-0xD800)<<10 + (lo - 0xDC00)
						p.i += 6
					}
				}
				out = appendWTF8(out, r)
			default:
				return "", p.fail("invalid escape")
			}
			start = p.i
		default:
			p.i++
		}
	}
	return "", p.fail("unterminated string")
}

// Marshal is JSON.stringify(v). NaN and ±Infinity are null, as there.
func Marshal(v any) []byte {
	return AppendValue(nil, v)
}

// AppendValue appends v's JSON to b.
func AppendValue(b []byte, v any) []byte {
	switch t := v.(type) {
	case nil:
		return append(b, "null"...)
	case bool:
		if t {
			return append(b, "true"...)
		}
		return append(b, "false"...)
	case float64:
		return AppendNumber(b, t)
	case int:
		return AppendNumber(b, float64(t))
	case int64:
		return AppendNumber(b, float64(t))
	case string:
		return AppendString(b, t)
	case []any:
		b = append(b, '[')
		for i, e := range t {
			if i > 0 {
				b = append(b, ',')
			}
			b = AppendValue(b, e)
		}
		return append(b, ']')
	case []string:
		b = append(b, '[')
		for i, e := range t {
			if i > 0 {
				b = append(b, ',')
			}
			b = AppendString(b, e)
		}
		return append(b, ']')
	case *Object:
		if t == nil {
			return append(b, "null"...)
		}
		b = append(b, '{')
		for i, m := range t.members {
			if i > 0 {
				b = append(b, ',')
			}
			b = AppendString(b, m.Key)
			b = append(b, ':')
			b = AppendValue(b, m.Value)
		}
		return append(b, '}')
	}
	panic(fmt.Sprintf("jsjson: cannot encode %T", v))
}

// AppendNumber appends f as Number#toString writes it in JSON. This is the
// ECMAScript algorithm encoding/json also follows: shortest round-trip digits,
// plain notation from 1e-6 up to 1e21, exponent form outside it.
func AppendNumber(b []byte, f float64) []byte {
	if math.IsNaN(f) || math.IsInf(f, 0) {
		return append(b, "null"...)
	}
	if f == 0 {
		// -0 is "0" in JSON.stringify.
		return append(b, '0')
	}
	abs := math.Abs(f)
	format := byte('f')
	if abs < 1e-6 || abs >= 1e21 {
		format = 'e'
	}
	b = strconv.AppendFloat(b, f, format, -1, 64)
	if format == 'e' {
		// 1e-07 → 1e-7, as JavaScript writes it.
		n := len(b)
		if n >= 4 && b[n-4] == 'e' && b[n-3] == '-' && b[n-2] == '0' {
			b[n-2] = b[n-1]
			b = b[:n-1]
		}
	}
	return b
}

const hexDigits = "0123456789abcdef"

// AppendString appends s quoted as JSON.stringify quotes it. Invalid UTF-8
// (which a JavaScript string can't hold) is written as U+FFFD.
func AppendString(b []byte, s string) []byte {
	b = append(b, '"')
	start := 0
	for i := 0; i < len(s); {
		c := s[i]
		if c < utf8.RuneSelf {
			if c >= 0x20 && c != '"' && c != '\\' {
				i++
				continue
			}
			b = append(b, s[start:i]...)
			switch c {
			case '"':
				b = append(b, '\\', '"')
			case '\\':
				b = append(b, '\\', '\\')
			case '\b':
				b = append(b, '\\', 'b')
			case '\f':
				b = append(b, '\\', 'f')
			case '\n':
				b = append(b, '\\', 'n')
			case '\r':
				b = append(b, '\\', 'r')
			case '\t':
				b = append(b, '\\', 't')
			default:
				b = append(b, '\\', 'u', '0', '0', hexDigits[c>>4], hexDigits[c&0xf])
			}
			i++
			start = i
			continue
		}
		r, size := utf8.DecodeRuneInString(s[i:])
		if c == 0xED && i+2 < len(s) && s[i+1] >= 0xA0 && s[i+1] <= 0xBF && s[i+2] >= 0x80 && s[i+2] <= 0xBF {
			// A lone surrogate, as Parse keeps one (WTF-8): JSON.stringify
			// writes it as an escape.
			u := 0xD000 | rune(s[i+1]&0x3F)<<6 | rune(s[i+2]&0x3F)
			b = append(b, s[start:i]...)
			b = append(b, '\\', 'u', hexDigits[u>>12&0xf], hexDigits[u>>8&0xf], hexDigits[u>>4&0xf], hexDigits[u&0xf])
			i += 3
			start = i
			continue
		}
		if r == utf8.RuneError && size == 1 {
			b = append(b, s[start:i]...)
			b = append(b, "�"...)
			i += size
			start = i
			continue
		}
		i += size
	}
	b = append(b, s[start:]...)
	return append(b, '"')
}

// Equal reports whether a and b stringify to the same JSON, the comparison
// Node makes with JSON.stringify(a) === JSON.stringify(b).
func Equal(a, b any) bool {
	return bytes.Equal(Marshal(a), Marshal(b))
}

// Number is v as a JavaScript number: a float64, or a Go int a caller set
// (AppendValue writes those as numbers too).
func Number(v any) (float64, bool) {
	switch t := v.(type) {
	case float64:
		return t, true
	case int:
		return float64(t), true
	case int64:
		return float64(t), true
	}
	return 0, false
}

// Truthy is JavaScript truthiness for a parsed value.
func Truthy(v any) bool {
	if f, ok := Number(v); ok {
		return f != 0 && !math.IsNaN(f)
	}
	switch t := v.(type) {
	case nil:
		return false
	case bool:
		return t
	case string:
		return t != ""
	case *Object:
		return t != nil
	}
	return true
}
