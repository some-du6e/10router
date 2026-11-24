package claudeprep

import (
	"errors"
	"math"
	"math/big"
	"sort"
	"strconv"
	"strings"
	"unicode/utf8"
)

// Kind is the JavaScript type of a Value.
type Kind uint8

const (
	// KindUndefined is a member JS code set to undefined: JSON.stringify skips
	// it in an object and writes null for it in an array.
	KindUndefined Kind = iota
	KindNull
	KindBool
	KindNumber
	KindString
	KindArray
	KindObject
)

// Value is one JSON value as Node holds it after JSON.parse: objects keep
// JavaScript's property order (array-index keys ascending, then insertion
// order, a repeated key in its first slot), strings are UTF-16 semantics
// stored as WTF-8 (a lone surrogate keeps its own 3-byte sequence), numbers
// are float64 written back by Number#toString. A *Value of kind Array or
// Object is a reference, as in JavaScript: every holder sees an edit.
//
// It never goes through map[string]any, so nothing reorders keys or rounds
// numbers in a way Node doesn't.
type Value struct {
	kind  Kind
	b     bool
	plain bool // str needs no escaping inside quotes
	f     float64
	// str: a string's content, or a number's own text when it is already
	// Number#toString's ("" otherwise). One field for both, and the flags
	// packed first, keep a Value at 64 bytes: a 4 MB body of tiny values is
	// millions of them.
	str string
	arr []*Value
	obj *object
}

type member struct {
	key string
	val *Value
}

type object struct {
	members []member
	index   map[string]int
}

var (
	undefinedValue = &Value{kind: KindUndefined}
	nullValue      = &Value{kind: KindNull}
)

// Undefined is JavaScript's undefined, for a member set to it.
func Undefined() *Value { return undefinedValue }

// Null is JSON null.
func Null() *Value { return nullValue }

// Bool is a JSON boolean.
func Bool(b bool) *Value {
	if b {
		return trueValue
	}
	return falseValue
}

// Scalars are never edited in place (a Set replaces the pointer), so these
// are shared.
var (
	trueValue  = &Value{kind: KindBool, b: true}
	falseValue = &Value{kind: KindBool}
)

// Number is a JSON number with value f.
func Number(f float64) *Value { return &Value{kind: KindNumber, f: f} }

// String is a JSON string holding s (WTF-8).
func String(s string) *Value { return &Value{kind: KindString, str: s, plain: !needsEscape(s)} }

// Array is a new JSON array of items.
func Array(items ...*Value) *Value {
	if items == nil {
		items = []*Value{}
	}
	return &Value{kind: KindArray, arr: items}
}

// Object is a new empty JSON object.
func Object() *Value { return &Value{kind: KindObject, obj: &object{}} }

// Kind is v's type; a nil *Value (a missing member) is undefined.
func (v *Value) Kind() Kind {
	if v == nil {
		return KindUndefined
	}
	return v.kind
}

func (v *Value) IsUndefined() bool { return v == nil || v.kind == KindUndefined }
func (v *Value) IsNullish() bool   { return v == nil || v.kind == KindUndefined || v.kind == KindNull }
func (v *Value) IsObject() bool    { return v != nil && v.kind == KindObject }
func (v *Value) IsArray() bool     { return v != nil && v.kind == KindArray }
func (v *Value) IsString() bool    { return v != nil && v.kind == KindString }
func (v *Value) IsNumber() bool    { return v != nil && v.kind == KindNumber }

// Str is the string's content ("" for any other kind).
func (v *Value) Str() string {
	if v == nil || v.kind != KindString {
		return ""
	}
	return v.str
}

// Float is the number's value (NaN for any other kind).
func (v *Value) Float() float64 {
	if v == nil || v.kind != KindNumber {
		return math.NaN()
	}
	return v.f
}

// Is reports v === s for a string s.
func (v *Value) Is(s string) bool { return v != nil && v.kind == KindString && v.str == s }

// Truthy is JavaScript's ToBoolean.
func (v *Value) Truthy() bool {
	switch v.Kind() {
	case KindBool:
		return v.b
	case KindNumber:
		return v.f != 0 && !math.IsNaN(v.f)
	case KindString:
		return v.str != ""
	case KindArray, KindObject:
		return true
	}
	return false
}

// ---- Arrays ----------------------------------------------------------------

// Items is the array's elements (nil for any other kind), the array's own slice.
func (v *Value) Items() []*Value {
	if v == nil || v.kind != KindArray {
		return nil
	}
	return v.arr
}

// Len is the array's length or the object's member count.
func (v *Value) Len() int {
	switch v.Kind() {
	case KindArray:
		return len(v.arr)
	case KindObject:
		return len(v.obj.members)
	}
	return 0
}

// ---- Objects ---------------------------------------------------------------

// isArrayIndex is ECMAScript's array index: a canonical uint32 below 2^32-1.
// Such keys enumerate first, ascending, whatever order they were added in.
func isArrayIndex(k string) bool {
	if k == "" || len(k) > 10 || (len(k) > 1 && k[0] == '0') {
		return false
	}
	var n uint64
	for i := 0; i < len(k); i++ {
		c := k[i]
		if c < '0' || c > '9' {
			return false
		}
		n = n*10 + uint64(c-'0')
	}
	return n < 4294967295
}

func indexValue(k string) uint64 {
	n, _ := strconv.ParseUint(k, 10, 64)
	return n
}

func (o *object) find(key string) int {
	if o.index != nil {
		if i, ok := o.index[key]; ok {
			return i
		}
		return -1
	}
	for i := range o.members {
		if o.members[i].key == key {
			return i
		}
	}
	if len(o.members) > 16 {
		o.reindex()
	}
	return -1
}

func (o *object) reindex() {
	o.index = make(map[string]int, len(o.members))
	for i, m := range o.members {
		o.index[m.key] = i
	}
}

// Get is v[key] for an own member, nil when there is none (or v is no object).
func (v *Value) Get(key string) *Value {
	if v == nil || v.kind != KindObject {
		return nil
	}
	if i := v.obj.find(key); i >= 0 {
		return v.obj.members[i].val
	}
	return nil
}

// Has reports an own member named key (`key in v` for a plain object, with
// no prototype names: callers check those themselves).
func (v *Value) Has(key string) bool {
	return v != nil && v.kind == KindObject && v.obj.find(key) >= 0
}

// Set is v[key] = val: a member keeps its slot, a new one goes where
// JavaScript would enumerate it. v must be an object: inside Prepare
// anything else is a decline, elsewhere it panics.
func (v *Value) Set(key string, val *Value) {
	if v == nil || v.kind != KindObject {
		// A property set on a primitive throws in strict-mode Node; on an
		// array it is invisible to JSON. Neither is modelled.
		decline("a property set on something that isn't an object")
	}
	o := v.obj
	if i := o.find(key); i >= 0 {
		o.members[i].val = val
		return
	}
	at := len(o.members)
	if isArrayIndex(key) {
		n := indexValue(key)
		at = sort.Search(len(o.members), func(i int) bool {
			k := o.members[i].key
			return !isArrayIndex(k) || indexValue(k) > n
		})
	}
	o.members = append(o.members, member{})
	copy(o.members[at+1:], o.members[at:])
	o.members[at] = member{key, val}
	if o.index != nil {
		if at == len(o.members)-1 {
			o.index[key] = at
		} else {
			o.index = nil // rebuilt by the next lookup that needs it
		}
	}
}

// Delete is `delete v[key]`.
func (v *Value) Delete(key string) {
	if v == nil || v.kind != KindObject {
		return
	}
	o := v.obj
	i := o.find(key)
	if i < 0 {
		return
	}
	o.members = append(o.members[:i], o.members[i+1:]...)
	if o.index != nil {
		// Patched in place (the slice copy above is the same order of work),
		// so a big object doesn't rebuild its map after every delete.
		delete(o.index, key)
		for _, m := range o.members[i:] {
			o.index[m.key]--
		}
	}
}

// Keys is Object.keys(v).
func (v *Value) Keys() []string {
	if v == nil || v.kind != KindObject {
		return nil
	}
	keys := make([]string, len(v.obj.members))
	for i, m := range v.obj.members {
		keys[i] = m.key
	}
	return keys
}

// Each calls fn for every member, in enumeration order.
func (v *Value) Each(fn func(key string, val *Value)) {
	if v == nil || v.kind != KindObject {
		return
	}
	for _, m := range v.obj.members {
		fn(m.key, m.val)
	}
}

// Spread is { ...v }: a new object with v's members (the values shared).
func (v *Value) Spread() *Value {
	out := Object()
	if v == nil || v.kind != KindObject {
		return out
	}
	out.obj.members = append(make([]member, 0, len(v.obj.members)+1), v.obj.members...)
	return out
}

// Without is `const { key, ...rest } = v`: rest.
func (v *Value) Without(keys ...string) *Value {
	out := v.Spread()
	for _, k := range keys {
		out.Delete(k)
	}
	return out
}

// Clone is structuredClone(v) for a JSON value: a deep copy.
func (v *Value) Clone() *Value {
	switch v.Kind() {
	case KindArray:
		items := make([]*Value, len(v.arr))
		for i, it := range v.arr {
			items[i] = it.Clone()
		}
		return &Value{kind: KindArray, arr: items}
	case KindObject:
		out := Object()
		out.obj.members = make([]member, len(v.obj.members))
		for i, m := range v.obj.members {
			out.obj.members[i] = member{m.key, m.val.Clone()}
		}
		return out
	}
	return v
}

// ---- Parsing ---------------------------------------------------------------

// ErrSyntax is a body JSON.parse would reject.
var ErrSyntax = errors.New("claudeprep: invalid JSON")

// maxDepth: Node's own recursion (translation, structuredClone,
// JSON.stringify) overflows its stack a few thousand levels down and fails
// the request; well below that the port parses, beyond it Node decides.
const maxDepth = 512

// Parse reads a request body the way Node's readJsonObject does:
// request.text() (UTF-8 with replacement characters, a leading BOM dropped),
// then JSON.parse.
func Parse(data []byte) (*Value, error) {
	return parseText(decodeUTF8(data))
}

// parseText is JSON.parse of a string Node already holds (WTF-8 here, a
// lone surrogate kept): no byte decoding, no BOM rule.
func parseText(text string) (*Value, error) {
	p := parser{s: text}
	p.ws()
	v, err := p.value(0)
	if err != nil {
		return nil, err
	}
	p.ws()
	if p.i != len(p.s) {
		return nil, ErrSyntax
	}
	return v, nil
}

// decodeUTF8 is TextDecoder("utf-8").decode: a BOM dropped, each maximal
// ill-formed subsequence replaced by U+FFFD (the WHATWG rule, which differs
// from Go's one-byte-at-a-time replacement for truncated sequences).
func decodeUTF8(data []byte) string {
	if len(data) >= 3 && data[0] == 0xEF && data[1] == 0xBB && data[2] == 0xBF {
		data = data[3:]
	}
	return decodeUTF8KeepBOM(data)
}

// decodeUTF8KeepBOM is UTF-8 decode without BOM sniffing (the URL
// standard's percent-decoded strings).
func decodeUTF8KeepBOM(data []byte) string {
	if utf8.Valid(data) {
		return string(data)
	}
	var b strings.Builder
	b.Grow(len(data) + 16)
	for i := 0; i < len(data); {
		c := data[i]
		if c < 0x80 {
			b.WriteByte(c)
			i++
			continue
		}
		need, lo, hi := 0, byte(0x80), byte(0xBF)
		switch {
		case c >= 0xC2 && c <= 0xDF:
			need = 1
		case c == 0xE0:
			need, lo = 2, 0xA0
		case c >= 0xE1 && c <= 0xEC, c == 0xEE, c == 0xEF:
			need = 2
		case c == 0xED:
			need, hi = 2, 0x9F
		case c == 0xF0:
			need, lo = 3, 0x90
		case c >= 0xF1 && c <= 0xF3:
			need = 3
		case c == 0xF4:
			need, hi = 3, 0x8F
		default:
			b.WriteString("�")
			i++
			continue
		}
		j := i + 1
		ok := true
		for k := 0; k < need; k++ {
			if j >= len(data) {
				ok = false
				break
			}
			d := data[j]
			if k == 0 {
				if d < lo || d > hi {
					ok = false
					break
				}
			} else if d < 0x80 || d > 0xBF {
				ok = false
				break
			}
			j++
		}
		if ok {
			b.Write(data[i:j])
		} else {
			b.WriteString("�")
		}
		i = j
	}
	return b.String()
}

type parser struct {
	s string
	i int
}

func (p *parser) ws() {
	for p.i < len(p.s) {
		switch p.s[p.i] {
		case ' ', '\t', '\n', '\r':
			p.i++
		default:
			return
		}
	}
}

// errTooDeep: past maxDepth the port gives the body to Node.
var errTooDeep = &DeclineError{"JSON nested deeper than the port parses"}

func (p *parser) value(depth int) (*Value, error) {
	if depth > maxDepth {
		return nil, errTooDeep
	}
	if p.i >= len(p.s) {
		return nil, ErrSyntax
	}
	switch c := p.s[p.i]; {
	case c == '{':
		return p.object(depth)
	case c == '[':
		return p.array(depth)
	case c == '"':
		return p.string()
	case c == 't':
		return p.literal("true", Bool(true))
	case c == 'f':
		return p.literal("false", Bool(false))
	case c == 'n':
		return p.literal("null", nullValue)
	case c == '-' || (c >= '0' && c <= '9'):
		return p.number()
	}
	return nil, ErrSyntax
}

func (p *parser) literal(word string, v *Value) (*Value, error) {
	if !strings.HasPrefix(p.s[p.i:], word) {
		return nil, ErrSyntax
	}
	p.i += len(word)
	return v, nil
}

// object collects members in source order (a repeated key replaces the value
// in its first slot) and moves array-index keys to the front, ascending, once
// at the end: JSON.parse's resulting property order, in O(n log n).
func (p *parser) object(depth int) (*Value, error) {
	p.i++
	o := &object{}
	out := &Value{kind: KindObject, obj: o}
	p.ws()
	if p.i < len(p.s) && p.s[p.i] == '}' {
		p.i++
		return out, nil
	}
	var seen map[string]int
	indexKeys := false
	add := func(key string, v *Value) {
		if seen != nil {
			if i, ok := seen[key]; ok {
				o.members[i].val = v
				return
			}
		} else {
			for i := range o.members {
				if o.members[i].key == key {
					o.members[i].val = v
					return
				}
			}
		}
		o.members = append(o.members, member{key, v})
		if isArrayIndex(key) {
			indexKeys = true
		}
		if seen != nil {
			seen[key] = len(o.members) - 1
		} else if len(o.members) > 16 {
			seen = make(map[string]int, 64)
			for i, m := range o.members {
				seen[m.key] = i
			}
		}
	}
	done := func() *Value {
		if indexKeys {
			sort.SliceStable(o.members, func(a, b int) bool {
				ka, kb := o.members[a].key, o.members[b].key
				ia, ib := isArrayIndex(ka), isArrayIndex(kb)
				if ia && ib {
					return indexValue(ka) < indexValue(kb)
				}
				return ia && !ib
			})
		}
		return out
	}
	for {
		p.ws()
		if p.i >= len(p.s) || p.s[p.i] != '"' {
			return nil, ErrSyntax
		}
		k, err := p.string()
		if err != nil {
			return nil, err
		}
		p.ws()
		if p.i >= len(p.s) || p.s[p.i] != ':' {
			return nil, ErrSyntax
		}
		p.i++
		p.ws()
		v, err := p.value(depth + 1)
		if err != nil {
			return nil, err
		}
		add(k.str, v)
		p.ws()
		if p.i >= len(p.s) {
			return nil, ErrSyntax
		}
		if p.s[p.i] == ',' {
			p.i++
			continue
		}
		if p.s[p.i] == '}' {
			p.i++
			return done(), nil
		}
		return nil, ErrSyntax
	}
}

func (p *parser) array(depth int) (*Value, error) {
	p.i++
	items := []*Value{}
	p.ws()
	if p.i < len(p.s) && p.s[p.i] == ']' {
		p.i++
		return Array(items...), nil
	}
	for {
		p.ws()
		v, err := p.value(depth + 1)
		if err != nil {
			return nil, err
		}
		items = append(items, v)
		p.ws()
		if p.i >= len(p.s) {
			return nil, ErrSyntax
		}
		if p.s[p.i] == ',' {
			p.i++
			continue
		}
		if p.s[p.i] == ']' {
			p.i++
			return Array(items...), nil
		}
		return nil, ErrSyntax
	}
}

func (p *parser) number() (*Value, error) {
	start := p.i
	s := p.s
	if s[p.i] == '-' {
		p.i++
	}
	if p.i >= len(s) {
		return nil, ErrSyntax
	}
	if s[p.i] == '0' {
		p.i++
	} else if s[p.i] >= '1' && s[p.i] <= '9' {
		for p.i < len(s) && s[p.i] >= '0' && s[p.i] <= '9' {
			p.i++
		}
	} else {
		return nil, ErrSyntax
	}
	simple := true
	if p.i < len(s) && s[p.i] == '.' {
		simple = false
		p.i++
		d := p.i
		for p.i < len(s) && s[p.i] >= '0' && s[p.i] <= '9' {
			p.i++
		}
		if p.i == d {
			return nil, ErrSyntax
		}
	}
	if p.i < len(s) && (s[p.i] == 'e' || s[p.i] == 'E') {
		simple = false
		p.i++
		if p.i < len(s) && (s[p.i] == '+' || s[p.i] == '-') {
			p.i++
		}
		d := p.i
		for p.i < len(s) && s[p.i] >= '0' && s[p.i] <= '9' {
			p.i++
		}
		if p.i == d {
			return nil, ErrSyntax
		}
	}
	text := s[start:p.i]
	f, err := strconv.ParseFloat(text, 64)
	if err != nil && !errors.Is(err, strconv.ErrRange) {
		return nil, ErrSyntax
	}
	v := &Value{kind: KindNumber, f: f}
	// Up to 15 digits an integer's own text is Number#toString's (but not "-0").
	digits := len(text)
	if text[0] == '-' {
		digits--
	}
	if simple && digits <= 15 && text != "-0" {
		v.str = text
	}
	return v, nil
}

func hexVal(c byte) int {
	switch {
	case c >= '0' && c <= '9':
		return int(c - '0')
	case c >= 'a' && c <= 'f':
		return int(c-'a') + 10
	case c >= 'A' && c <= 'F':
		return int(c-'A') + 10
	}
	return -1
}

func (p *parser) hex4(at int) int {
	if at+4 > len(p.s) {
		return -1
	}
	n := 0
	for k := 0; k < 4; k++ {
		h := hexVal(p.s[at+k])
		if h < 0 {
			return -1
		}
		n = n<<4 | h
	}
	return n
}

func (p *parser) string() (*Value, error) {
	p.i++
	start := p.i
	s := p.s
	plain := true
	for p.i < len(s) {
		c := s[p.i]
		if c == '"' {
			v := &Value{kind: KindString, str: s[start:p.i], plain: plain}
			p.i++
			return v, nil
		}
		if c == '\\' {
			break
		}
		if c == 0xED {
			// Possibly a lone surrogate (parseText's WTF-8 input): let
			// needsEscape's rule decide, as appendQuoted would.
			plain = false
		}
		if c < 0x20 {
			return nil, ErrSyntax
		}
		p.i++
	}
	var b strings.Builder
	b.WriteString(s[start:p.i])
	for p.i < len(s) {
		c := s[p.i]
		switch {
		case c == '"':
			p.i++
			out := b.String()
			return &Value{kind: KindString, str: out, plain: !needsEscape(out)}, nil
		case c < 0x20:
			return nil, ErrSyntax
		case c != '\\':
			b.WriteByte(c)
			p.i++
			continue
		}
		if p.i+1 >= len(s) {
			return nil, ErrSyntax
		}
		e := s[p.i+1]
		p.i += 2
		switch e {
		case '"', '\\', '/':
			b.WriteByte(e)
		case 'b':
			b.WriteByte('\b')
		case 'f':
			b.WriteByte('\f')
		case 'n':
			b.WriteByte('\n')
		case 'r':
			b.WriteByte('\r')
		case 't':
			b.WriteByte('\t')
		case 'u':
			u := p.hex4(p.i)
			if u < 0 {
				return nil, ErrSyntax
			}
			p.i += 4
			if u >= 0xD800 && u <= 0xDBFF && p.i+6 <= len(s) && s[p.i] == '\\' && s[p.i+1] == 'u' {
				if lo := p.hex4(p.i + 2); lo >= 0xDC00 && lo <= 0xDFFF {
					p.i += 6
					b.WriteRune(rune((u-0xD800)<<10 + (lo - 0xDC00) + 0x10000))
					continue
				}
			}
			writeUnit(&b, u)
		default:
			return nil, ErrSyntax
		}
	}
	return nil, ErrSyntax
}

// writeUnit writes one UTF-16 code unit: a lone surrogate as its own 3-byte
// (WTF-8) sequence, which utf8.EncodeRune would turn into U+FFFD.
func writeUnit(b *strings.Builder, u int) {
	if u >= 0xD800 && u <= 0xDFFF {
		b.WriteByte(byte(0xE0 | u>>12))
		b.WriteByte(byte(0x80 | (u>>6)&0x3F))
		b.WriteByte(byte(0x80 | u&0x3F))
		return
	}
	b.WriteRune(rune(u))
}

// ---- Serializing -------------------------------------------------------------

// needsEscape: JSON.stringify writes s with an escape somewhere (a control
// character, a quote, a backslash or a lone surrogate).
func needsEscape(s string) bool {
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c < 0x20 || c == '"' || c == '\\' || c == 0xED {
			return true
		}
	}
	return false
}

// Marshal is JSON.stringify(v) as UTF-8 bytes.
func Marshal(v *Value) []byte {
	return v.appendJSON(make([]byte, 0, 4096))
}

func (v *Value) appendJSON(dst []byte) []byte {
	switch v.Kind() {
	case KindUndefined, KindNull:
		return append(dst, "null"...)
	case KindBool:
		if v.b {
			return append(dst, "true"...)
		}
		return append(dst, "false"...)
	case KindNumber:
		if v.str != "" {
			return append(dst, v.str...)
		}
		if math.IsNaN(v.f) || math.IsInf(v.f, 0) {
			return append(dst, "null"...)
		}
		return append(dst, formatNumber(v.f)...)
	case KindString:
		return appendQuoted(dst, v.str, v.plain)
	case KindArray:
		dst = append(dst, '[')
		for i, it := range v.arr {
			if i > 0 {
				dst = append(dst, ',')
			}
			dst = it.appendJSON(dst)
		}
		return append(dst, ']')
	}
	dst = append(dst, '{')
	first := true
	for _, m := range v.obj.members {
		if m.val.IsUndefined() {
			continue
		}
		if !first {
			dst = append(dst, ',')
		}
		first = false
		dst = appendQuoted(dst, m.key, !needsEscape(m.key))
		dst = append(dst, ':')
		dst = m.val.appendJSON(dst)
	}
	return append(dst, '}')
}

const hexDigits = "0123456789abcdef"

func appendQuoted(dst []byte, s string, plain bool) []byte {
	dst = append(dst, '"')
	if plain {
		dst = append(dst, s...)
		return append(dst, '"')
	}
	for i := 0; i < len(s); {
		c := s[i]
		switch {
		case c == '"':
			dst = append(dst, '\\', '"')
		case c == '\\':
			dst = append(dst, '\\', '\\')
		case c == '\b':
			dst = append(dst, '\\', 'b')
		case c == '\f':
			dst = append(dst, '\\', 'f')
		case c == '\n':
			dst = append(dst, '\\', 'n')
		case c == '\r':
			dst = append(dst, '\\', 'r')
		case c == '\t':
			dst = append(dst, '\\', 't')
		case c < 0x20:
			dst = append(dst, '\\', 'u', '0', '0', hexDigits[c>>4], hexDigits[c&15])
		case c == 0xED && i+2 < len(s) && s[i+1] >= 0xA0:
			// A surrogate in WTF-8: a high one followed by a low one is a
			// pair (two strings joined), anything else is written \udxxx.
			u := 0xD000 | int(s[i+1]&0x3F)<<6 | int(s[i+2]&0x3F)
			if u <= 0xDBFF && i+5 < len(s) && s[i+3] == 0xED && s[i+4] >= 0xB0 {
				lo := 0xD000 | int(s[i+4]&0x3F)<<6 | int(s[i+5]&0x3F)
				dst = utf8.AppendRune(dst, rune((u-0xD800)<<10+(lo-0xDC00)+0x10000))
				i += 6
				continue
			}
			dst = append(dst, '\\', 'u', hexDigits[u>>12], hexDigits[(u>>8)&15], hexDigits[(u>>4)&15], hexDigits[u&15])
			i += 3
			continue
		default:
			dst = append(dst, c)
		}
		i++
	}
	return append(dst, '"')
}

// formatNumber is Number#toString(10) for a finite f (ECMA-262
// Number::toString): the shortest round-tripping digits, written plainly for
// exponents up to 21 and down to -6, in e-notation beyond.
func formatNumber(f float64) string {
	if f == 0 {
		return "0"
	}
	if math.IsNaN(f) {
		return "NaN"
	}
	if math.IsInf(f, 1) {
		return "Infinity"
	}
	if math.IsInf(f, -1) {
		return "-Infinity"
	}
	sign := ""
	if f < 0 {
		sign = "-"
		f = -f
	}
	e := strconv.FormatFloat(f, 'e', -1, 64) // d.ddddde±XX
	mant, exp, _ := strings.Cut(e, "e")
	digits := strings.Replace(mant, ".", "", 1)
	x, _ := strconv.Atoi(exp)
	k := len(digits)
	n := x + 1
	var out string
	switch {
	case k <= n && n <= 21:
		out = digits + strings.Repeat("0", n-k)
	case 0 < n && n <= 21:
		out = digits[:n] + "." + digits[n:]
	case -6 < n && n <= 0:
		out = "0." + strings.Repeat("0", -n) + digits
	default:
		es := "+"
		if n-1 < 0 {
			es = "-"
		}
		ev := n - 1
		if ev < 0 {
			ev = -ev
		}
		if k == 1 {
			out = digits + "e" + es + strconv.Itoa(ev)
		} else {
			out = digits[:1] + "." + digits[1:] + "e" + es + strconv.Itoa(ev)
		}
	}
	return sign + out
}

// ---- JavaScript string and number helpers ------------------------------------

// isJSSpace is JavaScript's WhiteSpace or LineTerminator (what trim removes).
func isJSSpace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ', 0xA0, 0x1680, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF:
		return true
	}
	return r >= 0x2000 && r <= 0x200A
}

// jsTrim is String#trim.
func jsTrim(s string) string {
	start := 0
	for start < len(s) {
		if s[start] < 0x80 {
			if !isJSSpace(rune(s[start])) {
				break
			}
			start++
			continue
		}
		r, w := utf8.DecodeRuneInString(s[start:])
		if r == utf8.RuneError || !isJSSpace(r) {
			break
		}
		start += w
	}
	end := len(s)
	for end > start {
		if s[end-1] < 0x80 {
			if !isJSSpace(rune(s[end-1])) {
				break
			}
			end--
			continue
		}
		r, w := utf8.DecodeLastRuneInString(s[start:end])
		if r == utf8.RuneError || !isJSSpace(r) {
			break
		}
		end -= w
	}
	return s[start:end]
}

// jsStringToNumber is Number(s) for a string (StringToNumber).
func jsStringToNumber(s string) float64 {
	t := jsTrim(s)
	if t == "" {
		return 0
	}
	switch t {
	case "Infinity", "+Infinity":
		return math.Inf(1)
	case "-Infinity":
		return math.Inf(-1)
	}
	if len(t) > 2 && t[0] == '0' {
		base := 0
		switch t[1] {
		case 'x', 'X':
			base = 16
		case 'o', 'O':
			base = 8
		case 'b', 'B':
			base = 2
		}
		if base != 0 {
			for i := 2; i < len(t); i++ {
				if d := hexVal(t[i]); d < 0 || d >= base {
					return math.NaN()
				}
			}
			// The exact integer, then rounded once to the nearest double.
			n, _ := new(big.Int).SetString(t[2:], base)
			f, _ := new(big.Float).SetInt(n).Float64()
			return f
		}
	}
	if !isDecimalLiteral(t) {
		return math.NaN()
	}
	f, err := strconv.ParseFloat(t, 64)
	if err != nil && !errors.Is(err, strconv.ErrRange) {
		return math.NaN()
	}
	return f
}

// isDecimalLiteral is StrDecimalLiteral without Infinity: [+-] digits [. digits] [e[+-]digits], or [+-] . digits ...
func isDecimalLiteral(t string) bool {
	i := 0
	if i < len(t) && (t[i] == '+' || t[i] == '-') {
		i++
	}
	intDigits := 0
	for i < len(t) && t[i] >= '0' && t[i] <= '9' {
		i++
		intDigits++
	}
	fracDigits := 0
	if i < len(t) && t[i] == '.' {
		i++
		for i < len(t) && t[i] >= '0' && t[i] <= '9' {
			i++
			fracDigits++
		}
	}
	if intDigits == 0 && fracDigits == 0 {
		return false
	}
	if i < len(t) && (t[i] == 'e' || t[i] == 'E') {
		i++
		if i < len(t) && (t[i] == '+' || t[i] == '-') {
			i++
		}
		d := 0
		for i < len(t) && t[i] >= '0' && t[i] <= '9' {
			i++
			d++
		}
		if d == 0 {
			return false
		}
	}
	return i == len(t)
}
