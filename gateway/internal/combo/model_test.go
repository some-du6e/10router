package combo

import (
	"context"
	"encoding/json"
	"os"
	"testing"

	"github.com/some-du6e/10router/gateway/internal/db"
	"github.com/some-du6e/10router/gateway/internal/db/dbtest"
	"github.com/some-du6e/10router/gateway/internal/db/jsjson"
	"github.com/some-du6e/10router/gateway/internal/decline"
)

// fixture is testdata/resolve.json, recorded from Node by
// tests/unit/gateway-combo-parity.test.js.
type fixture struct {
	// Rows are the tables as Node stored them.
	Rows  map[string][]map[string]any `json:"rows"`
	Cases []struct {
		Model string `json:"model"`
		Info  struct {
			Provider *string `json:"provider"`
			Model    *string `json:"model"`
			Threw    string  `json:"threw"`
		} `json:"info"`
		ComboModels     json.RawMessage `json:"comboModels"`
		ComboLookupName string          `json:"comboLookupName"`
	} `json:"cases"`
}

// LoadFixtureDB loads rows into a database shaped like Node's and reads them
// back through the gateway's snapshot, the production path.
func LoadFixtureDB(t *testing.T, rows map[string][]map[string]any) *db.Snapshot {
	t.Helper()
	path, node := dbtest.New(t, dbtest.Options{})
	dbtest.InsertRows(t, node, rows)
	d, err := db.Open(path, db.Options{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = d.Close() })
	s, err := d.LoadSnapshot(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func loadFixture(t *testing.T) (*fixture, *Config) {
	t.Helper()
	raw, err := os.ReadFile("testdata/resolve.json")
	if err != nil {
		t.Fatal(err)
	}
	var f fixture
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatal(err)
	}
	return &f, FromSnapshot(LoadFixtureDB(t, f.Rows))
}

func TestResolutionParityWithNode(t *testing.T) {
	f, c := loadFixture(t)
	if len(f.Cases) < 40 {
		t.Fatalf("only %d cases", len(f.Cases))
	}
	str := func(p *string) string {
		if p == nil {
			return ""
		}
		return *p
	}
	for _, tc := range f.Cases {
		t.Run(tc.Model, func(t *testing.T) {
			if got := ComboLookupName(tc.Model); got != tc.ComboLookupName {
				t.Errorf("ComboLookupName = %q, Node %q", got, tc.ComboLookupName)
			}
			info, err := c.ModelInfo(tc.Model)
			switch {
			case tc.Info.Threw != "":
				if err == nil {
					t.Errorf("Node threw %q; Go answered %+v", tc.Info.Threw, info)
				}
			case err != nil:
				t.Errorf("Go declined: %v", err)
			default:
				wantCombo := tc.Info.Provider == nil && tc.Info.Model != nil && tc.Model != ""
				if info.IsCombo != wantCombo || info.Provider != str(tc.Info.Provider) || info.Model != str(tc.Info.Model) {
					t.Errorf("ModelInfo = %+v, Node provider=%v model=%v", info, str(tc.Info.Provider), str(tc.Info.Model))
				}
			}

			var node any
			if err := json.Unmarshal(tc.ComboModels, &node); err != nil {
				t.Fatalf("fixture comboModels: %v", err)
			}
			members, err := c.ComboModels(tc.Model)
			nodeMembers, isArray := node.([]any)
			allStrings := isArray
			for _, m := range nodeMembers {
				if _, ok := m.(string); !ok {
					allStrings = false
				}
			}
			if node != nil && !allStrings {
				// Members Node would route however its loops read them (a
				// non-string member, a string of members, a throw): declined.
				if !decline.Is(err) {
					t.Errorf("Node's members %s aren't a list of strings; Go must decline, got %v, %v", tc.ComboModels, members, err)
				}
				return
			}
			if err != nil {
				t.Fatalf("Go declined: %v", err)
			}
			if len(members) != len(nodeMembers) || (node == nil) != (members == nil) {
				t.Fatalf("ComboModels = %#v, Node %s", members, tc.ComboModels)
			}
			for i := range members {
				if members[i] != nodeMembers[i] {
					t.Errorf("member %d = %q, Node %v", i, members[i], nodeMembers[i])
				}
			}
		})
	}
}

func TestDeclinesIDsNodeReadsDifferently(t *testing.T) {
	_, c := loadFixture(t)
	for _, id := range []string{"constructor", "hot/toString", "__proto__/x", "deepseeK-r1", "café", "tab\tmodel"} {
		if _, err := c.ModelInfo(id); !decline.Is(err) {
			t.Errorf("ModelInfo(%q) did not decline: %v", id, err)
		}
	}
	for _, id := range []string{"constructor", "café"} {
		if _, err := c.ComboModels(id); !decline.Is(err) {
			t.Errorf("ComboModels(%q) did not decline: %v", id, err)
		}
	}
}

// /\[(\d+[km])\]$/i without the u flag matches only ASCII letters.
func TestContextWindowSuffixIsASCII(t *testing.T) {
	for in, want := range map[string]string{
		"main[1m]": "main", "main[200K]": "main", "main[1M]": "main",
		"main[1K]": "main[1K]", "main[1g]": "main[1g]", "main[m]": "main[m]",
	} {
		if got := StripContextWindowSuffix(in); got != want {
			t.Errorf("StripContextWindowSuffix(%q) = %q, want %q", in, got, want)
		}
	}
}

// Stored shapes Node reads through JavaScript's object rules.
func TestDeclinesStoredShapesNodeReadsItsOwnWay(t *testing.T) {
	aliases, err := jsjson.ParseObject([]byte(`{"__proto__":{"inherited":"hot/model-a"},"plain":"constructor/x","objModel":{"provider":"hot","model":"toString"}}`))
	if err != nil {
		t.Fatal(err)
	}
	c := &Config{Aliases: aliases, Combos: map[string]any{"lengthy": jsjson.NewObject(), "empty": "", "num": 5.0}}
	// kvStore.getAll's assignment makes "__proto__" the alias map's prototype.
	if _, err := c.ModelInfo("inherited"); !decline.Is(err) {
		t.Errorf("an alias Node would inherit was resolved: %v", err)
	}
	c.Aliases.Delete("__proto__")
	for _, alias := range []string{"plain", "objModel"} {
		if _, err := c.ModelInfo(alias); !decline.Is(err) {
			t.Errorf("%s: an alias naming Object.prototype was resolved: %v", alias, err)
		}
	}
	if _, err := c.ComboModels("lengthy"); !decline.Is(err) {
		t.Errorf("object-shaped members: %v", err)
	}
	for _, name := range []string{"empty", "num"} {
		if m, err := c.ComboModels(name); m != nil || err != nil {
			t.Errorf("%s: Node finds no members; got %v %v", name, m, err)
		}
	}
}
