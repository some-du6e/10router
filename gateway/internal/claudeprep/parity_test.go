package claudeprep

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

// The golden fixtures recorded from Node by
// tests/unit/gateway-claudeprep-parity.test.js: testdata/fixtures, plus the
// large corpus CI generates into $CLAUDEPREP_FIXTURES. Every fixture Node
// prepared must come out of Prepare byte for byte; the ones the generator
// marks expectDecline, and every one Node threw on, must be handed back to
// Node instead. A decline on anything else fails.

type fixture struct {
	Name   string `json:"name"`
	Inputs struct {
		Provider             string          `json:"provider"`
		Model                string          `json:"model"`
		APIKey               string          `json:"apiKey"`
		AccessToken          string          `json:"accessToken"`
		ProviderSpecificData json.RawMessage `json:"providerSpecificData"`
		ProviderThinking     *struct {
			Mode string `json:"mode"`
		} `json:"providerThinking"`
		KeyHasBudget bool            `json:"keyHasBudget"`
		Catalog      *fixtureCatalog `json:"catalog"`
	} `json:"inputs"`
	Request struct {
		Headers    map[string]string `json:"headers"`
		Body       *string           `json:"body"`
		BodyBase64 string            `json:"bodyBase64"`
	} `json:"request"`
	ExpectDecline string `json:"expectDecline"`
	Node          struct {
		Error   string      `json:"error"`
		URL     string      `json:"url"`
		Headers [][2]string `json:"headers"`
		Body    string      `json:"body"`
	} `json:"node"`
}

type fixtureCatalog struct {
	Limits     map[string]struct{ MaxOutput float64 } `json:"limits"`
	Modalities map[string]Modalities                  `json:"modalities"`
}

type catalogAdapter struct{ c *fixtureCatalog }

func (a catalogAdapter) Modalities(model string) (Modalities, bool) {
	m, ok := a.c.Modalities[model]
	return m, ok
}

func (a catalogAdapter) Limits(provider, model string) (Limits, bool) {
	l, ok := a.c.Limits[provider+" "+model]
	return Limits{MaxOutput: l.MaxOutput}, ok
}

func loadFixtures(t *testing.T) []string {
	t.Helper()
	dirs := []string{filepath.Join("testdata", "fixtures")}
	if extra := os.Getenv("CLAUDEPREP_FIXTURES"); extra != "" {
		dirs = append(dirs, extra)
	}
	var files []string
	for _, d := range dirs {
		m, err := filepath.Glob(filepath.Join(d, "*.json"))
		if err != nil {
			t.Fatal(err)
		}
		files = append(files, m...)
	}
	sort.Strings(files)
	return files
}

func (f *fixture) inputs(t *testing.T) Inputs {
	node, err := ParseNodeSettings(f.Inputs.ProviderSpecificData)
	if err != nil {
		t.Fatalf("%s: %v", f.Name, err)
	}
	in := Inputs{
		Provider:      f.Inputs.Provider,
		Model:         f.Inputs.Model,
		ClientHeaders: f.Request.Headers,
		KeyHasBudget:  f.Inputs.KeyHasBudget,
		Connection:    Connection{APIKey: f.Inputs.APIKey, AccessToken: f.Inputs.AccessToken, Node: node},
	}
	// The recorder hands Node a resolved blockedReason in providerSpecificData,
	// as getProviderCredentials would.
	var resolved map[string]json.RawMessage
	_ = json.Unmarshal(f.Inputs.ProviderSpecificData, &resolved)
	if raw, ok := resolved["blockedReason"]; ok {
		v, err := Parse(raw)
		in.Connection.Blocked = err == nil && v.Truthy()
	}
	if f.Inputs.ProviderThinking != nil {
		in.ProviderThinking = f.Inputs.ProviderThinking.Mode
	}
	if f.Inputs.Catalog != nil {
		in.Models = NewModels(catalogAdapter{f.Inputs.Catalog})
	}
	return in
}

func (f *fixture) body(t *testing.T) []byte {
	if f.Request.Body != nil {
		return []byte(*f.Request.Body)
	}
	b, err := base64.StdEncoding.DecodeString(f.Request.BodyBase64)
	if err != nil {
		t.Fatalf("%s: %v", f.Name, err)
	}
	return b
}

// firstDiff shows where two byte strings part.
func firstDiff(got, want []byte) string {
	i := 0
	for i < len(got) && i < len(want) && got[i] == want[i] {
		i++
	}
	lo := i - 120
	if lo < 0 {
		lo = 0
	}
	clip := func(b []byte) string {
		hi := i + 120
		if hi > len(b) {
			hi = len(b)
		}
		if lo > len(b) {
			return ""
		}
		return string(b[lo:hi])
	}
	return fmt.Sprintf("first difference at byte %d (got %d bytes, want %d)\n got: …%s…\nwant: …%s…", i, len(got), len(want), clip(got), clip(want))
}

func TestParityWithNode(t *testing.T) {
	files := loadFixtures(t)
	// CI sets the floor to what it generated, so an empty or misnamed
	// CLAUDEPREP_FIXTURES can't pass on the committed fixtures alone.
	floor := 100
	if s := os.Getenv("CLAUDEPREP_MIN_FIXTURES"); s != "" {
		if _, err := fmt.Sscan(s, &floor); err != nil {
			t.Fatal(err)
		}
	}
	if len(files) < floor {
		t.Fatalf("only %d fixtures, want %d or more", len(files), floor)
	}
	var identical, declined, total int
	var declineReasons = map[string]int{}
	for _, file := range files {
		data, err := os.ReadFile(file)
		if err != nil {
			t.Fatal(err)
		}
		var f fixture
		if err := json.Unmarshal(data, &f); err != nil {
			t.Fatalf("%s: %v", file, err)
		}
		total++
		t.Run(f.Name, func(t *testing.T) {
			in := f.inputs(t)
			req, err := Prepare(f.body(t), in)
			switch {
			case f.Node.Error != "":
				if !IsDecline(err) {
					t.Fatalf("Node failed (%s) but Prepare gave %v, %v", f.Node.Error, req != nil, err)
				}
				declined++
				declineReasons[err.Error()]++
				return
			case f.ExpectDecline != "":
				if !IsDecline(err) || !strings.Contains(err.Error(), f.ExpectDecline) {
					t.Fatalf("expected a decline for %q, got %v", f.ExpectDecline, err)
				}
				declined++
				declineReasons[err.Error()]++
				return
			case err != nil:
				t.Fatalf("Prepare: %v", err)
			}
			if req.URL != f.Node.URL {
				t.Errorf("URL %q, Node %q", req.URL, f.Node.URL)
			}
			var got [][2]string
			accept := false
			for _, h := range req.Header {
				v := h.Value
				if f.Inputs.APIKey != "" {
					v = strings.ReplaceAll(v, f.Inputs.APIKey, "{{apiKey}}")
				}
				if f.Inputs.AccessToken != "" {
					v = strings.ReplaceAll(v, f.Inputs.AccessToken, "{{accessToken}}")
				}
				accept = accept || h.Name == "Accept" && h.Value == "text/event-stream"
				got = append(got, [2]string{h.Name, v})
			}
			// Stream is the executor's flag, which sets the SSE Accept header
			// unless the node's own header lines rewrite Accept.
			lines := in.Connection.Node.Mimic == "custom" || in.Connection.Node.Overrides != nil && in.Connection.Node.Overrides.Headers != ""
			if !lines && req.Stream != accept {
				t.Errorf("Stream %v, but the SSE Accept header is %v", req.Stream, accept)
			}
			if fmt.Sprint(got) != fmt.Sprint(f.Node.Headers) {
				t.Errorf("headers\n got %v\nNode %v", got, f.Node.Headers)
			}
			if !bytes.Equal(req.Body, []byte(f.Node.Body)) {
				t.Errorf("body: %s", firstDiff(req.Body, []byte(f.Node.Body)))
				return
			}
			if !t.Failed() {
				identical++
			}
		})
	}
	prepared := total - declined
	t.Logf("corpus: %d fixtures; %d prepared by Node and Go, %d byte-identical (%.1f%%); %d handed to Node", total, prepared, identical, 100*float64(identical)/float64(max(prepared, 1)), declined)
	for r, n := range declineReasons {
		t.Logf("  declined %d× %s", n, r)
	}
	if out := os.Getenv("CLAUDEPREP_REPORT"); out != "" {
		report := fmt.Sprintf("claudeprep parity: %d fixtures, %d prepared, %d byte-identical (%.1f%%), %d handed to Node\n", total, prepared, identical, 100*float64(identical)/float64(max(prepared, 1)), declined)
		_ = os.WriteFile(out, []byte(report), 0o644)
	}
}
