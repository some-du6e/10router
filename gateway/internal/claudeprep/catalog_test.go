package claudeprep

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

type catalogFixture struct {
	Cases []struct {
		Name     string  `json:"name"`
		File     *string `json:"file"`
		Provider string  `json:"provider"`
		Lookups  []struct {
			Model      string      `json:"model"`
			Modalities *Modalities `json:"modalities"`
			Limits     *struct {
				// A number, or text for a value Go can't hold.
				MaxOutput any `json:"maxOutput"`
			} `json:"limits"`
			Caps struct {
				Vision     bool `json:"vision"`
				PDF        bool `json:"pdf"`
				AudioInput bool `json:"audioInput"`
				// A number, or text for a value Go can't hold.
				MaxOutput any `json:"maxOutput"`
			} `json:"caps"`
		} `json:"lookups"`
	} `json:"cases"`
}

// catalogMayDecline are the recorded files with shapes sync.js never writes,
// where FileCatalog declines rather than index them as JS would.
var catalogMayDecline = map[string]bool{
	"models an array":            true,
	"provider entry an array":    true,
	"entry an array":             true,
	"maxOutput a string":         true,
	"maxOutput true":             true,
	"maxOutput beyond a float64": true,
}

// catching runs f, turning a decline into an error.
func catching(f func()) (err error) {
	defer func() {
		if r := recover(); r != nil {
			d, ok := r.(declined)
			if !ok {
				panic(r)
			}
			err = &DeclineError{d.reason}
		}
	}()
	f()
	return nil
}

// TestCatalogMatchesNode replays tests/unit/gateway-catalog-parity.test.js:
// each catalog file through FileCatalog's lookups and NewModels' refine.
// Only what refine can use is compared: an entry Node finds that holds no
// modality (a string, a function) is the same as none.
func TestCatalogMatchesNode(t *testing.T) {
	raw, err := os.ReadFile("testdata/catalog.json")
	if err != nil {
		t.Fatal(err)
	}
	var fx catalogFixture
	if err := json.Unmarshal(raw, &fx); err != nil {
		t.Fatal(err)
	}
	if len(fx.Cases) < 30 {
		t.Fatalf("%d cases; the recorder writes more", len(fx.Cases))
	}
	declines := 0
	for _, c := range fx.Cases {
		t.Run(c.Name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "model-catalog.json")
			if c.File != nil {
				if err := os.WriteFile(path, []byte(*c.File), 0o600); err != nil {
					t.Fatal(err)
				}
			}
			cat := NewFileCatalog(path)
			models := NewModels(cat)
			for _, l := range c.Lookups {
				var mod Modalities
				var lim Limits
				var caps Caps
				err := catching(func() {
					mod, _ = cat.Modalities(l.Model)
					lim, _ = cat.Limits(c.Provider, l.Model)
					caps = models.Capabilities(c.Provider, l.Model)
				})
				if err != nil {
					if !catalogMayDecline[c.Name] {
						t.Fatalf("%q: declined (%v) on a shape sync.js writes", l.Model, err)
					}
					declines++
					continue
				}
				want := Modalities{}
				if l.Modalities != nil {
					want = *l.Modalities
				}
				if mod != want {
					t.Errorf("%q: modalities %+v, Node %+v", l.Model, mod, want)
				}
				wantMax := any(0.0)
				if l.Limits != nil {
					wantMax = l.Limits.MaxOutput
				}
				if n, ok := wantMax.(float64); !ok || lim.MaxOutput != n {
					t.Errorf("%q: limits maxOutput %v, Node %v", l.Model, lim.MaxOutput, wantMax)
				}
				if caps.Vision != l.Caps.Vision || caps.PDF != l.Caps.PDF || caps.AudioInput != l.Caps.AudioInput {
					t.Errorf("%q: caps vision/pdf/audio %v/%v/%v, Node %v/%v/%v", l.Model, caps.Vision, caps.PDF, caps.AudioInput, l.Caps.Vision, l.Caps.PDF, l.Caps.AudioInput)
				}
				n, isNumber := l.Caps.MaxOutput.(float64)
				if !isNumber {
					t.Errorf("%q: Node's maxOutput is %v and Go didn't decline", l.Model, l.Caps.MaxOutput)
				} else if caps.MaxOutput != n {
					t.Errorf("%q: caps maxOutput %v, Node %v", l.Model, caps.MaxOutput, n)
				}
			}
		})
	}
	if declines == 0 {
		t.Error("no recorded shape declined; the decline list is stale")
	}
}

// TestCatalogFollowsTheFile is load's cache: a changed mtime is re-read, a
// removed file is empty, a bad one is empty until it is fixed.
func TestCatalogFollowsTheFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "model-catalog.json")
	cat := NewFileCatalog(path)
	write := func(text string, at time.Time) {
		t.Helper()
		if err := os.WriteFile(path, []byte(text), 0o600); err != nil {
			t.Fatal(err)
		}
		if err := os.Chtimes(path, at, at); err != nil {
			t.Fatal(err)
		}
	}
	vision := func() bool { m, _ := cat.Modalities("mystery-1"); return m.Vision }
	t0 := time.Now().Add(-time.Hour)
	if vision() {
		t.Fatal("no file: vision on")
	}
	write(`{"models":{"mystery-1":{"vision":true}}}`, t0)
	if !vision() {
		t.Fatal("new file not read")
	}
	write(`{"models":{}}`, t0.Add(time.Second))
	if vision() {
		t.Fatal("changed file not re-read")
	}
	write(`{"models":`, t0.Add(2*time.Second))
	if vision() {
		t.Fatal("a bad file isn't empty")
	}
	write(`{"models":{"mystery-1":{"vision":true}}}`, t0.Add(3*time.Second))
	if !vision() {
		t.Fatal("fixed file not re-read")
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if vision() {
		t.Fatal("removed file still read")
	}
}

// TestCatalogArrayDeclines: a shape FileCatalog won't read is a decline,
// which Prepare turns into its DeclineError.
func TestCatalogArrayDeclines(t *testing.T) {
	err := catching(func() { NewFileCatalog(writeTemp(t, `{"models":[{"vision":true}]}`)).Modalities("0") })
	var d *DeclineError
	if !errors.As(err, &d) {
		t.Fatalf("got %v, want a decline", err)
	}
}

// DeclineCovered declines what a maxOutput or a declared modality could
// change, and reads every other lookup as no entry.
func TestDeclineCovered(t *testing.T) {
	path := writeTemp(t, `{"models":{"mystery-1":{"vision":true},"zeta-9":{"vision":false},"omega-2":{"pdf":true},"kappa-3":{"audioInput":true}},"providers":{"p":{"mystery-1":{"maxOutput":3000},"zeta-9":{"contextWindow":5}}}}`)
	c := DeclineCovered(NewFileCatalog(path))
	for _, model := range []string{"zeta-9", "other"} {
		var m Modalities
		var l Limits
		var mok, lok bool
		if err := catching(func() { m, mok = c.Modalities(model); l, lok = c.Limits("p", model) }); err != nil || mok || lok || m != (Modalities{}) || l != (Limits{}) {
			t.Fatalf("%s: %+v %v %+v %v %v", model, m, mok, l, lok, err)
		}
	}
	var d *DeclineError
	for _, tc := range []struct {
		name, want string
		f          func()
	}{
		{"maxOutput by base id", "maxOutput", func() { c.Limits("p", "acme/Mystery-1") }},
		{"vision", "modality", func() { c.Modalities("mystery-1") }},
		{"pdf", "modality", func() { c.Modalities("vendor/Omega-2:free") }},
		{"audio", "modality", func() { c.Modalities("kappa-3") }},
		// Through Prepare's capabilities, as the native route reads them.
		{"capabilities", "synced model catalog", func() { NewModels(c).Capabilities("p", "omega-2") }},
	} {
		if err := catching(tc.f); !errors.As(err, &d) || !strings.Contains(d.Reason, tc.want) {
			t.Fatalf("%s: got %v, want a decline naming %q", tc.name, err, tc.want)
		}
	}
}

func writeTemp(t *testing.T, text string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "model-catalog.json")
	if err := os.WriteFile(path, []byte(text), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}
