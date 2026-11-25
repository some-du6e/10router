package gatewayfiles

import (
	"strings"
	"testing"
)

func TestProxyOnlyParsing(t *testing.T) {
	got := parseProxyOnly("# comment\n\n  combo  \n# another\nroute\n")
	if len(got) != 2 || got[0] != "combo" || got[1] != "route" {
		t.Fatalf("got %q", got)
	}
}

func TestNativeOff(t *testing.T) {
	mapped := []string{"claudeprep", "combo", "route"}
	if r := nativeOff(nil, mapped); r != "" {
		t.Fatalf("nothing listed: %q", r)
	}
	if r := nativeOff([]string{"combo"}, mapped); !strings.Contains(r, "combo") {
		t.Fatalf("listed: %q", r)
	}
	if r := nativeOff([]string{"typo"}, mapped); !strings.Contains(r, "not a package") {
		t.Fatalf("unknown name: %q", r)
	}
}

// A map that can't be read turns native off with a reason; it never panics,
// since the answer is worked out at start in every mode.
func TestUnreadableMapTurnsNativeOff(t *testing.T) {
	for name, data := range map[string]string{
		"not JSON":      `{"route": [`,
		"not an object": `["route"]`,
		"empty":         ``,
		"no packages":   `{"_comment": "x"}`,
	} {
		t.Run(name, func(t *testing.T) {
			r := NativeOffFor("", []byte(data))
			if !strings.Contains(r, "node-map.json") || !strings.Contains(r, "native routes stay off") {
				t.Fatalf("reason %q", r)
			}
		})
	}
	if r := NativeOffFor("", []byte(`{"route": ["a.js"]}`)); r != "" {
		t.Fatalf("a readable map with nothing listed: %q", r)
	}
}

// The embedded files are the module root's.
func TestEmbeddedFiles(t *testing.T) {
	mapped, err := MappedPackages()
	if err != nil || len(mapped) < 5 {
		t.Fatalf("node-map.json maps %v (%v)", mapped, err)
	}
	for _, p := range ProxyOnly() {
		if strings.ContainsAny(p, " \t") {
			t.Fatalf("GATEWAY_PROXY_ONLY line %q", p)
		}
	}
}
