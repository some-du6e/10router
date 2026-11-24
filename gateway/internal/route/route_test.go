package route

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/some-du6e/10router/gateway/internal/decline"
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

func uaHeader(ua string) http.Header {
	h := http.Header{}
	if ua != "" {
		h.Set("User-Agent", ua)
	}
	return h
}

func TestInspectParityWithNode(t *testing.T) {
	f := load(t)
	if len(f.Cases) < 55 {
		t.Fatalf("only %d cases", len(f.Cases))
	}
	for _, tc := range f.Cases {
		t.Run(tc.Name, func(t *testing.T) {
			raw, err := base64.StdEncoding.DecodeString(tc.BodyBase64)
			if err != nil {
				t.Fatal(err)
			}
			req, err := Inspect(raw, uaHeader(tc.UA), tc.CCFilterNaming)
			nodeRoutes := tc.Node.Status == 0 && tc.Node.Threw == "" && !tc.Node.Bypass
			if err != nil {
				if !decline.Is(err) {
					t.Fatalf("not a decline: %v", err)
				}
				if nodeRoutes && tc.Conservative == "" {
					t.Fatalf("Go declined a body Node routes: %v", err)
				}
				if tc.Conservative != "" && !strings.Contains(err.Error(), tc.Conservative) {
					t.Fatalf("declined for another reason than %q: %v", tc.Conservative, err)
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

// Node keeps only the first User-Agent; Go reads them all, so a warmup behind
// any of them goes to Node (stricter, never looser).
func TestUserAgentValuesAreJoined(t *testing.T) {
	h := http.Header{}
	h.Add("User-Agent", "proxy-agent/1.0")
	h.Add("User-Agent", "claude-cli/2.1.0")
	_, err := Inspect([]byte(`{"model":"main","stream":true,"messages":[{"role":"user","content":"Warmup"}]}`), h, false)
	if !decline.Is(err) || !strings.Contains(err.Error(), "warmup") {
		t.Fatalf("a warmup behind a second User-Agent must go to Node: %v", err)
	}
}

// The phase 2a corpus is production-shaped (Claude Code histories, tools,
// cache_control, images): the shape gate lets every streamed one through,
// so native would serve them.
func TestProductionShapedBodiesPass(t *testing.T) {
	files, err := filepath.Glob("../claudeprep/testdata/fixtures/*.json")
	if err != nil || len(files) < 100 {
		t.Fatalf("claudeprep fixtures: %d, %v", len(files), err)
	}
	streamed := 0
	for _, file := range files {
		// The cases built for claudeprep to decline are not the hot path's shape.
		if strings.HasPrefix(filepath.Base(file), "decline-") {
			continue
		}
		raw, err := os.ReadFile(file)
		if err != nil {
			t.Fatal(err)
		}
		var f struct {
			Request struct {
				Headers    map[string]string `json:"headers"`
				Body       string            `json:"body"`
				BodyBase64 string            `json:"bodyBase64"`
			} `json:"request"`
		}
		if err := json.Unmarshal(raw, &f); err != nil {
			t.Fatal(err)
		}
		body := []byte(f.Request.Body)
		if f.Request.BodyBase64 != "" {
			if body, err = base64.StdEncoding.DecodeString(f.Request.BodyBase64); err != nil {
				t.Fatal(err)
			}
		}
		var shape struct {
			Stream any `json:"stream"`
		}
		if json.Unmarshal(body, &shape) != nil || shape.Stream != true {
			continue
		}
		streamed++
		if _, err := Inspect(body, uaHeader(f.Request.Headers["user-agent"]), false); err != nil {
			t.Errorf("%s: %v", filepath.Base(file), err)
		}
	}
	if streamed < 100 {
		t.Fatalf("only %d streamed fixtures", streamed)
	}
}

// The paths are /api/v1/messages and every next.config.mjs rewrite onto
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
	got := slices.Clone(paths)
	slices.Sort(got)
	slices.Sort(want)
	if !slices.Equal(got, want) {
		t.Fatalf("paths = %v, rewrites give %v", got, want)
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
