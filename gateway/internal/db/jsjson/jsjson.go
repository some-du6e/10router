// Package jsjson reads and writes JSON the way JavaScript's JSON.parse and
// JSON.stringify do, so a row the gateway rewrites is the text Node would have
// written: object keys keep their order (array-index keys first, ascending, as
// V8 orders them), numbers are float64 printed as Number#toString prints them,
// and strings are escaped as JSON.stringify escapes them (no HTML escaping,
// no U+2028/U+2029 escaping).
//
// Values are nil (null), bool, float64, string, []any and *Object.
package jsjson

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
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

// MarshalJSON lets an *Object sit inside values encoding/json writes.
func (o *Object) MarshalJSON() ([]byte, error) { return Marshal(o), nil }

// String is the object's JSON.
func (o *Object) String() string { return string(Marshal(o)) }

// ErrNotObject is returned by ParseObject for valid JSON that isn't an object.
var ErrNotObject = errors.New("jsjson: not an object")

// Parse reads one JSON value as JSON.parse would. A duplicate key keeps its
// first position and its last value.
func Parse(data []byte) (any, error) {
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.UseNumber()
	v, err := parseValue(dec)
	if err != nil {
		return nil, err
	}
	if _, err := dec.Token(); err != io.EOF {
		return nil, errors.New("jsjson: trailing data")
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

func parseValue(dec *json.Decoder) (any, error) {
	tok, err := dec.Token()
	if err != nil {
		return nil, err
	}
	switch t := tok.(type) {
	case json.Delim:
		switch t {
		case '{':
			o := &Object{}
			for dec.More() {
				kt, err := dec.Token()
				if err != nil {
					return nil, err
				}
				key, ok := kt.(string)
				if !ok {
					return nil, fmt.Errorf("jsjson: object key %v", kt)
				}
				v, err := parseValue(dec)
				if err != nil {
					return nil, err
				}
				o.Set(key, v)
			}
			if _, err := dec.Token(); err != nil {
				return nil, err
			}
			return o, nil
		case '[':
			arr := []any{}
			for dec.More() {
				v, err := parseValue(dec)
				if err != nil {
					return nil, err
				}
				arr = append(arr, v)
			}
			if _, err := dec.Token(); err != nil {
				return nil, err
			}
			return arr, nil
		}
		return nil, fmt.Errorf("jsjson: unexpected %v", t)
	case json.Number:
		// JSON.parse rounds to the nearest double, as ParseFloat does; a
		// literal past the double range is ±Infinity there and an error here.
		f, err := strconv.ParseFloat(string(t), 64)
		if err != nil {
			var ne *strconv.NumError
			if errors.As(err, &ne) && errors.Is(ne.Err, strconv.ErrRange) {
				return f, nil
			}
			return nil, err
		}
		return f, nil
	case string, bool, nil:
		return t, nil
	}
	return nil, fmt.Errorf("jsjson: unexpected token %v", tok)
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
	case json.RawMessage:
		// Already JSON; re-read so it is written in JavaScript's form.
		parsed, err := Parse(t)
		if err != nil {
			return append(b, "null"...)
		}
		return AppendValue(b, parsed)
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

// Truthy is JavaScript truthiness for a parsed value.
func Truthy(v any) bool {
	switch t := v.(type) {
	case nil:
		return false
	case bool:
		return t
	case float64:
		return t != 0 && !math.IsNaN(t)
	case string:
		return t != ""
	}
	return true
}
