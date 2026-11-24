package claudeprep

import (
	"encoding/base64"
	"strings"
	"testing"
)

// Expectations are Node's own: JSON.stringify(JSON.parse(text)), and
// new Response(bytes).text() for the byte cases.

func roundTrip(t *testing.T, in string) string {
	t.Helper()
	v, err := Parse([]byte(in))
	if err != nil {
		t.Fatalf("Parse(%q): %v", in, err)
	}
	return string(Marshal(v))
}

func TestJSNumbers(t *testing.T) {
	cases := [][2]string{
		{"0", "0"}, {"-0", "0"}, {"1", "1"}, {"1.0", "1"}, {"1e3", "1000"}, {"1E+2", "100"},
		{"-1.5e-7", "-1.5e-7"}, {"0.000001", "0.000001"}, {"1e-7", "1e-7"}, {"1e21", "1e+21"},
		{"123456789012345678901", "123456789012345680000"}, {"12345678901234567890", "12345678901234567000"},
		{"9007199254740993", "9007199254740992"}, {"5e-324", "5e-324"},
		{"1.7976931348623157e308", "1.7976931348623157e+308"}, {"1e400", "null"}, {"-1e400", "null"},
		{"0.1", "0.1"}, {"0.30000000000000004", "0.30000000000000004"}, {"100.000", "100"},
		{"2.5E-3", "0.0025"}, {"123e-20", "1.23e-18"}, {"1.23e+21", "1.23e+21"}, {"4.35", "4.35"},
		{"1e-6", "0.000001"}, {"0.0000012345", "0.0000012345"}, {"-0.0", "0"},
	}
	for _, c := range cases {
		if got := roundTrip(t, c[0]); got != c[1] {
			t.Errorf("%s: got %s, Node %s", c[0], got, c[1])
		}
	}
}

// esc writes a JSON escape: esc("00e9") is backslash-u-00e9.
func esc(hex string) string { return "\\" + "u" + hex }

func TestJSStrings(t *testing.T) {
	r := func(c rune) string { return string(c) }
	q := func(s string) string { return "\"" + s + "\"" }
	cases := [][2]string{
		{q("caf" + esc("00e9")), q("caf" + r(0xE9))},
		{q("\\/"), q("/")},
		{q(esc("d83d") + esc("de00")), q(r(0x1F600))},
		{q(esc("D83D") + esc("DE00")), q(r(0x1F600))},
		{q(esc("d800")), q(esc("d800"))},
		{q(esc("dc00") + "x"), q(esc("dc00") + "x")},
		{q(esc("d83d") + esc("0041")), q(esc("d83d") + "A")},
		{q(esc("2028")), q(r(0x2028))},
		{q(esc("0001") + esc("001f") + esc("007f")), q(esc("0001") + esc("001f") + "\x7f")},
		{q("\\b\\f\\n\\r\\t"), q("\\b\\f\\n\\r\\t")},
		{q("\\\"q\\\"\\\\"), q("\\\"q\\\"\\\\")},
		{q(r(0xE9) + r(0x1F600)), q(r(0xE9) + r(0x1F600))},
	}
	for _, c := range cases {
		if got := roundTrip(t, c[0]); got != c[1] {
			t.Errorf("%s: got %s, Node %s", c[0], got, c[1])
		}
	}
	// Two WTF-8 halves joined in Go are one pair in JavaScript.
	hi, _ := Parse([]byte(q(esc("d83d"))))
	lo, _ := Parse([]byte(q(esc("de00"))))
	if got := string(Marshal(String(hi.Str() + lo.Str()))); got != q(r(0x1F600)) {
		t.Errorf("joined surrogates: %s", got)
	}
}

func TestJSObjectOrder(t *testing.T) {
	cases := [][2]string{
		{`{"b":1,"a":2,"b":3}`, `{"b":3,"a":2}`},
		{`{"10":1,"2":2,"a":3,"1":4,"01":5,"4294967295":6,"4294967294":7}`, `{"1":4,"2":2,"10":1,"4294967294":7,"a":3,"01":5,"4294967295":6}`},
		{`{"__proto__":{"x":1},"y":2}`, `{"__proto__":{"x":1},"y":2}`},
		{" {\r\n\t\"a\" :\t[ 1 , 2 ] } ", `{"a":[1,2]}`},
	}
	for _, c := range cases {
		if got := roundTrip(t, c[0]); got != c[1] {
			t.Errorf("%s: got %s, Node %s", c[0], got, c[1])
		}
	}
	v := Object()
	v.Set("b", Number(1))
	v.Set("7", Number(2))
	v.Set("3", Number(3))
	v.Set("a", Number(4))
	v.Delete("b")
	v.Set("b", Number(5))
	if got := string(Marshal(v)); got != `{"3":3,"7":2,"a":4,"b":5}` {
		t.Errorf("JS property order: %s", got)
	}
	big := Object()
	for i := 0; i < 40; i++ {
		big.Set(strings.Repeat("k", i+1), Number(float64(i)))
	}
	big.Delete("kkk")
	big.Set("kkk", Bool(true))
	if !big.Get("kkk").Truthy() || big.Get("kk").Float() != 1 || big.Keys()[len(big.Keys())-1] != "kkk" {
		t.Errorf("indexed object lookups: %v", big.Keys())
	}
}

func TestJSTextDecoding(t *testing.T) {
	fffd := string(rune(0xFFFD))
	cases := [][2]string{
		{"IoAi", "\"" + fffd + "\""}, {"IuKCQSI=", "\"" + fffd + "A\""}, {"IsCvIg==", "\"" + fffd + fffd + "\""},
		{"Iv8i", "\"" + fffd + "\""}, {"IvCfmCI=", "\"" + fffd + "\""}, {"77u/ImEi", `"a"`},
		{"Iu2ggCI=", "\"" + strings.Repeat(fffd, 3) + "\""}, {"IvSQgIAi", "\"" + strings.Repeat(fffd, 4) + "\""},
	}
	for _, c := range cases {
		b, _ := base64.StdEncoding.DecodeString(c[0])
		v, err := Parse(b)
		if err != nil {
			t.Fatalf("%s: %v", c[0], err)
		}
		if got := string(Marshal(v)); got != c[1] {
			t.Errorf("%s: got %q, Node %q", c[0], got, c[1])
		}
	}
}

func TestJSTrim(t *testing.T) {
	r := func(c rune) string { return string(c) }
	nbsp, bom, ls, ps, nel, mvs := r(0xA0), r(0xFEFF), r(0x2028), r(0x2029), r(0x85), r(0x180E)
	cases := [][2]string{{"  a b " + nbsp + bom, "a b"}, {ls + "x" + ps, "x"}, {nel + "y", nel + "y"}, {mvs + "z", mvs + "z"}}
	for _, c := range cases {
		if got := jsTrim(c[0]); got != c[1] {
			t.Errorf("trim(%q) = %q, Node %q", c[0], got, c[1])
		}
	}
}

func TestJSRejectsWhatJSONParseRejects(t *testing.T) {
	for _, in := range []string{`{"a":1,}`, `[1,]`, `01`, `1.`, `.5`, `+1`, "\"a\nb\"", `{'a':1}`, `NaN`, `{"a" 1}`, `"\x"`, `"` + esc("12") + `"`, ``, `1 2`} {
		if _, err := Parse([]byte(in)); err == nil {
			t.Errorf("Parse(%q) accepted invalid JSON", in)
		}
	}
}

func TestJSStringToNumber(t *testing.T) {
	cases := map[string]float64{"": 0, "  42 ": 42, "0x1f": 31, "0b101": 5, "0o17": 15, "1e3": 1000, "-.5": -0.5, "5.": 5}
	for in, want := range cases {
		if got := jsStringToNumber(in); got != want {
			t.Errorf("Number(%q) = %v, want %v", in, got, want)
		}
	}
	if got := jsStringToNumber("Infinity"); got < 1e308 {
		t.Errorf("Number(Infinity) = %v", got)
	}
	for _, in := range []string{"abc", "1_000", "0x", "1e", "--1", "infinity", "0x1g"} {
		if got := jsStringToNumber(in); got == got {
			t.Errorf("Number(%q) = %v, want NaN", in, got)
		}
	}
}

func TestMatchPattern(t *testing.T) {
	cases := []struct {
		p, s string
		ok   bool
	}{
		{"*claude*opus-4.8*", "claude-opus-4.8", true}, {"*claude*opus-4.8*", "claude-opus-4-8", false},
		{"*claude*", "CLAUDE-x", true}, {"hy3*", "hy3-preview", true}, {"hy3*", "xhy3", false},
		{"glm-5.3*", "glm-5.3-flash", true}, {"*a*b*c*", "aXbYc", true}, {"*a*b*c*", "acb", false}, {"*", "", true},
	}
	for _, c := range cases {
		if got := matchPattern(c.p, c.s); got != c.ok {
			t.Errorf("matchPattern(%q, %q) = %v", c.p, c.s, got)
		}
	}
}
