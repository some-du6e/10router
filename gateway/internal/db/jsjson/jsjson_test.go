package jsjson

import (
	"math"
	"strings"
	"testing"
)

func TestNumbersPrintAsJavaScript(t *testing.T) {
	// A runtime sum: the constant expression 0.1 + 0.2 is exactly 0.3 in Go.
	tenth, fifth := 0.1, 0.2
	// Expected values are what JSON.stringify prints in Node.
	for _, c := range []struct {
		in   float64
		want string
	}{
		{tenth + fifth, "0.30000000000000004"},
		{1e21, "1e+21"},
		{1e-7, "1e-7"},
		{1.5e-6, "0.0000015"},
		{0.000001, "0.000001"},
		{123456789012345680000, "123456789012345680000"},
		{math.Copysign(0, -1), "0"},
		{5, "5"},
		{-3.25, "-3.25"},
		{9007199254740992, "9007199254740992"},
		{1e300, "1e+300"},
		{5e-324, "5e-324"},
		{1.7976931348623157e308, "1.7976931348623157e+308"},
		{math.NaN(), "null"},
		{math.Inf(1), "null"},
		{0.0001234, "0.0001234"},
		{2.5e-7, "2.5e-7"},
	} {
		if got := string(Marshal(c.in)); got != c.want {
			t.Errorf("%v: got %s, want %s", c.in, got, c.want)
		}
	}
}

func TestStringsEscapeAsJavaScript(t *testing.T) {
	// U+2028 and U+2029 stay raw: JSON.stringify doesn't escape them.
	seps := string(rune(0x2028)) + string(rune(0x2029))
	in := "a\"b\\c\b\f\n\r\t\x01\x1f<>&" + seps + "\x7féπ😀"
	want := `"a\"b\\c\b\f\n\r\t\u0001\u001f<>&` + seps + "\x7féπ😀" + `"`
	if got := string(Marshal(in)); got != want {
		t.Fatalf("got %s\nwant %s", got, want)
	}
	if got := string(Marshal("ok\xffend")); got != "\"ok�end\"" {
		t.Fatalf("invalid UTF-8: %q", got)
	}
}

func TestKeysKeepJavaScriptOrder(t *testing.T) {
	o, err := ParseObject([]byte(`{"b":1,"2":2,"a":3,"1":4,"01":5,"4294967295":6,"4294967294":7}`))
	if err != nil {
		t.Fatal(err)
	}
	// V8: array-index keys first in ascending order, then the rest as inserted.
	if got := strings.Join(o.Keys(), ","); got != "1,2,4294967294,b,a,01,4294967295" {
		t.Fatalf("parse order: %s", got)
	}
	o.Set("0", true)
	o.Set("10", true)
	o.Set("z", true)
	o.Set("b", "again")
	if got := o.String(); got != `{"0":true,"1":4,"2":2,"10":true,"4294967294":7,"b":"again","a":3,"01":5,"4294967295":6,"z":true}` {
		t.Fatalf("after sets: %s", got)
	}
	o.Delete("a")
	o.Set("a", 1)
	if keys := o.Keys(); keys[len(keys)-1] != "a" {
		t.Fatalf("a deleted key comes back last: %v", keys)
	}
}

func TestDuplicateKeysKeepFirstPlaceAndLastValue(t *testing.T) {
	o, err := ParseObject([]byte(`{"a":1,"b":2,"a":3}`))
	if err != nil {
		t.Fatal(err)
	}
	if got := o.String(); got != `{"a":3,"b":2}` {
		t.Fatalf("got %s", got)
	}
}

func TestRoundTripIsStable(t *testing.T) {
	in := `{"x":[1,2.5,{"y":null,"z":[true,false]}],"s":"é","n":-0.0,"big":1e400}`
	v, err := Parse([]byte(in))
	if err != nil {
		t.Fatal(err)
	}
	// 1e400 is Infinity in JavaScript, which JSON.stringify writes as null.
	want := `{"x":[1,2.5,{"y":null,"z":[true,false]}],"s":"é","n":0,"big":null}`
	if got := string(Marshal(v)); got != want {
		t.Fatalf("got %s\nwant %s", got, want)
	}
	again, _ := Parse([]byte(want))
	if !Equal(v, again) {
		t.Fatal("not equal after a round trip")
	}
}

// esc is a JSON \u escape, built so no editor turns it into the character.
func esc(hex string) string { return "\\" + "u" + hex }

func TestLoneSurrogatesSurviveARoundTrip(t *testing.T) {
	// "…" + the first half of an emoji, as errorText.slice(0, 100) can leave
	// it: JSON.stringify writes the lone half back as the same escape.
	for _, in := range []string{
		`{"lastError":"rate limit ` + esc("d83d") + `"}`,
		`{"a":"` + esc("dc00") + `x` + esc("d800") + `"}`,
	} {
		v, err := Parse([]byte(in))
		if err != nil {
			t.Fatal(err)
		}
		if got := string(Marshal(v)); got != in {
			t.Fatalf("got %s, want %s", got, in)
		}
	}
	// A pair is one character, written raw.
	v, err := Parse([]byte(`"` + esc("d83d") + esc("de00") + `"`))
	if err != nil || v != "😀" {
		t.Fatalf("pair: %q %v", v, err)
	}
	if got := string(Marshal("😀")); got != `"😀"` {
		t.Fatalf("emoji: %s", got)
	}
}

func TestParseFollowsJSONGrammar(t *testing.T) {
	for _, bad := range []string{``, `01`, `1.`, `.5`, `-`, `+1`, `1e`, `[1,]`, `{"a":1,}`, `{a:1}`, `"\x"`, `"tab	in"`, `tru`, `nul`, `[`, `{"a"}`, `"` + esc("12g4") + `"`} {
		if _, err := Parse([]byte(bad)); err == nil {
			t.Errorf("%q parsed", bad)
		}
	}
	v, err := Parse([]byte(` {"a" : [ -0.5e+2 , 0 , 1E2, "\/\"\\\b\f\n\r\t" , true , false , null ] } `))
	if err != nil {
		t.Fatal(err)
	}
	if got := string(Marshal(v)); got != `{"a":[-50,0,100,"/\"\\\b\f\n\r\t",true,false,null]}` {
		t.Fatalf("got %s", got)
	}
}

func TestGoIntsAreNumbers(t *testing.T) {
	if f, ok := Number(120); !ok || f != 120 {
		t.Fatal("int")
	}
	if Truthy(0) || !Truthy(int64(3)) || Truthy((*Object)(nil)) {
		t.Fatal("truthiness of ints and a nil object")
	}
}

func TestParseRejectsTrailingData(t *testing.T) {
	if _, err := Parse([]byte(`{} {}`)); err == nil {
		t.Fatal("trailing value accepted")
	}
	if _, err := ParseObject([]byte(`[1]`)); err != ErrNotObject {
		t.Fatalf("array as object: %v", err)
	}
}

func TestTruthy(t *testing.T) {
	for _, v := range []any{nil, false, 0.0, math.NaN(), ""} {
		if Truthy(v) {
			t.Errorf("%v is falsy in JavaScript", v)
		}
	}
	for _, v := range []any{true, 1.0, "0", []any{}, NewObject()} {
		if !Truthy(v) {
			t.Errorf("%v is truthy in JavaScript", v)
		}
	}
}
