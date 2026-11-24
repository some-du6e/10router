package combo

import (
	"encoding/json"
	"errors"
	"os"
	"testing"

	"github.com/some-du6e/10router/gateway/internal/db/jsjson"
)

// fixture is testdata/resolve.json, recorded from Node by
// tests/unit/gateway-combo-parity.test.js.
type fixture struct {
	Config struct {
		Nodes  []map[string]any `json:"nodes"`
		Combos map[string][]any `json:"combos"`
	} `json:"config"`
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
	// The aliases keep their stored shapes: read them as Node's JSON does.
	var whole struct {
		Config struct {
			Aliases json.RawMessage `json:"aliases"`
		} `json:"config"`
	}
	if err := json.Unmarshal(raw, &whole); err != nil {
		t.Fatal(err)
	}
	aliases, err := jsjson.ParseObject(whole.Config.Aliases)
	if err != nil {
		t.Fatal(err)
	}
	c := &Config{Combos: f.Config.Combos, Aliases: aliases}
	for _, n := range f.Config.Nodes {
		node := Node{ID: n["id"].(string), Type: n["type"].(string)}
		if p, ok := n["prefix"].(string); ok {
			node.Prefix, node.HasPrefix = p, true
		}
		c.Nodes = append(c.Nodes, node)
	}
	return &f, c
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

			var nodeMembers []any
			_ = json.Unmarshal(tc.ComboModels, &nodeMembers)
			members, err := c.ComboModels(tc.Model)
			allStrings := true
			for _, m := range nodeMembers {
				if _, ok := m.(string); !ok {
					allStrings = false
				}
			}
			if !allStrings {
				// Members Node would route however its loops read them: declined.
				var d *DeclineError
				if !errors.As(err, &d) {
					t.Errorf("Node's members %v aren't all strings; Go must decline, got %v, %v", nodeMembers, members, err)
				}
				return
			}
			if err != nil {
				t.Fatalf("Go declined: %v", err)
			}
			if len(members) != len(nodeMembers) || (nodeMembers == nil) != (members == nil) {
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
		if _, err := c.ModelInfo(id); err == nil {
			t.Errorf("ModelInfo(%q) did not decline", id)
		}
		if _, err := c.ComboModels(id); err == nil && !containsSlash(id) {
			t.Errorf("ComboModels(%q) did not decline", id)
		}
	}
}

func containsSlash(s string) bool {
	for i := 0; i < len(s); i++ {
		if s[i] == '/' {
			return true
		}
	}
	return false
}
