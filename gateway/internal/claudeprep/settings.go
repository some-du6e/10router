package claudeprep

import (
	"bytes"
	"encoding/json"
	"fmt"
)

// ParseNodeSettings decodes a connection's providerSpecificData JSON (as
// stored in providerConnections.data) into NodeSettings. A field with a type
// sanitizeNodeQuirks never writes is an error, so the caller proxies the
// request rather than guess how Node would read it; so is a null
// droppedBetas, on which Node's beta filter throws.
func ParseNodeSettings(data []byte) (NodeSettings, error) {
	var raw struct {
		APIType             *string           `json:"apiType"`
		BaseURL             *string           `json:"baseUrl"`
		ModelRoutes         map[string]string `json:"modelRoutes"`
		DroppedBetas        json.RawMessage   `json:"droppedBetas"`
		StripBeta           *bool             `json:"stripBeta"`
		MaxCompletionTokens *bool             `json:"maxCompletionTokens"`
		APIKeyHeader        *string           `json:"apiKeyHeader"`
		AuthHeader          *string           `json:"authHeader"`
		Mimic               *string           `json:"mimic"`
		CustomHeaders       *string           `json:"customHeaders"`
		Overrides           *struct {
			Path    string `json:"path"`
			Query   string `json:"query"`
			Headers string `json:"headers"`
			Body    string `json:"body"`
			Drop    string `json:"drop"`
			Models  string `json:"models"`
			Stream  string `json:"stream"`
			Timeout string `json:"timeout"`
			Retries string `json:"retries"`
			Proxy   string `json:"proxy"`
		} `json:"overrides"`
		BlockForeignTools *bool `json:"blockForeignTools"`
		StripReasoning    *bool `json:"stripReasoning"`
	}
	dec := json.NewDecoder(bytes.NewReader(data))
	if err := dec.Decode(&raw); err != nil {
		return NodeSettings{}, fmt.Errorf("claudeprep: providerSpecificData: %w", err)
	}
	str := func(p *string) string {
		if p == nil {
			return ""
		}
		return *p
	}
	flag := func(p *bool) bool { return p != nil && *p }
	n := NodeSettings{
		APIType: str(raw.APIType), BaseURL: str(raw.BaseURL), ModelRoutes: raw.ModelRoutes,
		StripBeta: flag(raw.StripBeta), MaxCompletionTokens: flag(raw.MaxCompletionTokens),
		APIKeyHeader: str(raw.APIKeyHeader), AuthHeader: str(raw.AuthHeader), Mimic: str(raw.Mimic),
		CustomHeaders: str(raw.CustomHeaders), BlockForeignTools: flag(raw.BlockForeignTools),
		StripReasoning: flag(raw.StripReasoning),
	}
	if len(raw.DroppedBetas) > 0 {
		if string(raw.DroppedBetas) == "null" {
			return NodeSettings{}, fmt.Errorf("claudeprep: providerSpecificData.droppedBetas is null")
		}
		if err := json.Unmarshal(raw.DroppedBetas, &n.DroppedBetas); err != nil {
			return NodeSettings{}, fmt.Errorf("claudeprep: providerSpecificData.droppedBetas: %w", err)
		}
		if n.DroppedBetas == nil {
			n.DroppedBetas = []string{}
		}
	}
	if o := raw.Overrides; o != nil {
		n.Overrides = &Overrides{
			Path: o.Path, Query: o.Query, Headers: o.Headers, Body: o.Body, Drop: o.Drop,
			Models: o.Models, Stream: o.Stream, Timeout: o.Timeout, Retries: o.Retries, Proxy: o.Proxy,
		}
	}
	return n, nil
}
