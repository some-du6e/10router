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

// The embedded files are the module root's, and every package the map names
// has its directory under internal/.
func TestEmbeddedFiles(t *testing.T) {
	mapped := MappedPackages()
	if len(mapped) < 5 {
		t.Fatalf("node-map.json maps %v", mapped)
	}
	for _, p := range ProxyOnly() {
		if strings.ContainsAny(p, " \t") {
			t.Fatalf("GATEWAY_PROXY_ONLY line %q", p)
		}
	}
}
