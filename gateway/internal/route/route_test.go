package route

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"os"
	"slices"
	"strings"
	"testing"
)

// fixture is testdata/cases.json, recorded from Node by
// tests/unit/gateway-route-parity.test.js.
type fixture struct {
	APIV1Rewrites []string `json:"apiV1Rewrites"`
	Cases         []struct {
		Name           string `json:"name"`
		BodyBase64     string `json:"bodyBase64"`
		UA             string `json:"ua"`
		CCFilterNaming bool   `json:"ccFilterNaming"`
		Conservative   string `json:"conservative"`
		Node           struct {
			Status int    `json:"status"`
			Threw  string `json:"threw"`
			Model  string `json:"model"`
			Bypass bool   `json:"bypass"`
		} `json:"node"`
	} `json:"cases"`
}

func load(t *testing.T) *fixture {
	t.Helper()
	raw, err := os.ReadFile("testdata/cases.json")
	if err != nil {
		t.Fatal(err)
	}
	var f fixture
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatal(err)
	}
	return &f
}

func TestInspectParityWithNode(t *testing.T) {
	f := load(t)
	if len(f.Cases) < 50 {
		t.Fatalf("only %d cases", len(f.Cases))
	}
	for _, tc := range f.Cases {
		t.Run(tc.Name, func(t *testing.T) {
			raw, err := base64.StdEncoding.DecodeString(tc.BodyBase64)
			if err != nil {
				t.Fatal(err)
			}
			req, err := Inspect(raw, tc.UA, tc.CCFilterNaming)
			nodeRoutes := tc.Node.Status == 0 && tc.Node.Threw == "" && !tc.Node.Bypass
			if err != nil {
				var d *DeclineError
				if !errors.As(err, &d) {
					t.Fatalf("not a decline: %v", err)
				}
				if nodeRoutes && tc.Conservative == "" {
					t.Fatalf("Go declined a body Node routes: %v", err)
				}
				return
			}
			if !nodeRoutes {
				t.Fatalf("Go would serve a body Node answers itself (%+v)", tc.Node)
			}
			if tc.Conservative != "" {
				t.Fatalf("expected the conservative decline (%s)", tc.Conservative)
			}
			if req.Model != tc.Node.Model {
				t.Errorf("model %q, Node %q", req.Model, tc.Node.Model)
			}
		})
	}
}

// Paths are /api/v1/messages and every next.config.mjs rewrite onto
// /api/v1/:path* with messages for the path.
func TestPathsFollowTheRewrites(t *testing.T) {
	f := load(t)
	want := []string{"/api/v1/messages"}
	for _, src := range f.APIV1Rewrites {
		if !strings.HasSuffix(src, "/:path*") {
			t.Fatalf("rewrite source %q has no :path* to fill", src)
		}
		want = append(want, strings.TrimSuffix(src, ":path*")+"messages")
	}
	got := slices.Clone(Paths)
	slices.Sort(got)
	slices.Sort(want)
	if !slices.Equal(got, want) {
		t.Fatalf("Paths = %v, rewrites give %v", got, want)
	}
}

func TestMatch(t *testing.T) {
	for _, tc := range []struct {
		method, uri string
		want        bool
	}{
		{"POST", "/v1/messages", true},
		{"POST", "/v1/messages?beta=true", true},
		{"POST", "/v1/v1/messages", true},
		{"POST", "/api/v1/messages", true},
		{"GET", "/v1/messages", false},
		{"OPTIONS", "/v1/messages", false},
		{"POST", "/v1/messages/", false},
		{"POST", "/v1/messages/count_tokens", false},
		{"POST", "/v1//messages", false},
		{"POST", "//v1/messages", false},
		{"POST", "/v1/Messages", false},
		{"POST", "/v1/%6Dessages", false},
		{"POST", "http://example.test/v1/messages", false},
		{"POST", "/v1/messages#x", false},
	} {
		if got := Match(tc.method, tc.uri); got != tc.want {
			t.Errorf("Match(%s %s) = %v", tc.method, tc.uri, got)
		}
	}
}
