package clientip

import (
	"encoding/json"
	"net/http/httptest"
	"os"
	"reflect"
	"testing"
)

type parityCase struct {
	Name       string            `json:"name"`
	SocketIP   string            `json:"socketIp"`
	TrustProxy string            `json:"trustProxy"`
	Headers    map[string]string `json:"headers"`
	Want       struct {
		Keys   []string `json:"keys"`
		Local  bool     `json:"local"`
		Tunnel bool     `json:"tunnel"`
	} `json:"want"`
}

// The same table tests/unit/gateway-clientip-parity.test.js runs against
// custom-server.js.
func TestParityWithCustomServer(t *testing.T) {
	raw, err := os.ReadFile("testdata/parity.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []parityCase
	if err := json.Unmarshal(raw, &cases); err != nil {
		t.Fatal(err)
	}
	if len(cases) < 30 {
		t.Fatalf("parity table has %d cases", len(cases))
	}
	for _, c := range cases {
		t.Run(c.Name, func(t *testing.T) {
			rule := NewRule(c.TrustProxy)
			h := FromMap(c.Headers)
			if got := rule.ClientKeys(h, c.SocketIP); !reflect.DeepEqual(got, c.Want.Keys) {
				t.Errorf("ClientKeys = %q, want %q", got, c.Want.Keys)
			}
			if got := rule.IsOnThisMachine(h, c.SocketIP); got != c.Want.Local {
				t.Errorf("IsOnThisMachine = %v, want %v", got, c.Want.Local)
			}
			if got := IsTunnelTraffic(h, c.SocketIP); got != c.Want.Tunnel {
				t.Errorf("IsTunnelTraffic = %v, want %v", got, c.Want.Tunnel)
			}
		})
	}
}

func TestIsLoopbackHost(t *testing.T) {
	for value, want := range map[string]bool{
		"localhost": true, "LOCALHOST:3000": true, "127.0.0.1": true, "127.0.0.1:80": true,
		"::1": true, "[::1]": true, "[::1]:20128": true, "::ffff:127.0.0.1": true, "0.0.0.0": true,
		"127.0.0.2": false, "[::1": false, "": false, "  ": false, "example.test": false, "0:0:0:0:0:0:0:1": false,
	} {
		if got := IsLoopbackHost(value); got != want {
			t.Errorf("IsLoopbackHost(%q) = %v, want %v", value, got, want)
		}
	}
}

func TestJSInteger(t *testing.T) {
	for text, want := range map[string]int{"": 0, " 24 ": 24, "24.0": 24, "0x18": 24, "1e1": 10, "+8": 8, "-0": 0} {
		got, ok := jsInteger(text)
		if !ok || got != want {
			t.Errorf("jsInteger(%q) = %d, %v; want %d", text, got, ok, want)
		}
	}
	for _, text := range []string{"abc", "8.5", "Infinity", "NaN", "0x", "1_0", "-0x8"} {
		if _, ok := jsInteger(text); ok {
			t.Errorf("jsInteger(%q) accepted", text)
		}
	}
}

func TestFromRequestJoinsRepeats(t *testing.T) {
	r := httptest.NewRequest("GET", "http://router.example.test/v1/models", nil)
	r.Header.Add("X-Forwarded-For", "198.51.100.1")
	r.Header.Add("X-Forwarded-For", "198.51.100.2")
	h := FromRequest(r)
	if got := h("x-forwarded-for"); got != "198.51.100.1, 198.51.100.2" {
		t.Errorf("x-forwarded-for = %q", got)
	}
	if got := h("host"); got != "router.example.test" {
		t.Errorf("host = %q", got)
	}
	if got := h("x-real-ip"); got != "" {
		t.Errorf("absent header = %q", got)
	}
}
