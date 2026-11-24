package claudeprep

import (
	"encoding/json"
	"fmt"
)

// ParseNodeSettings decodes a connection's providerSpecificData JSON (as
// stored in providerConnections.data) into NodeSettings. Keys match exactly,
// as Node reads them (encoding/json alone would also take "BASEURL"). A
// field with a type sanitizeNodeQuirks never writes is an error, so the
// caller proxies the request rather than guess how Node would read it; so is
// a null droppedBetas, on which Node's beta filter throws.
func ParseNodeSettings(data []byte) (NodeSettings, error) {
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(data, &raw); err != nil {
		return NodeSettings{}, fmt.Errorf("claudeprep: providerSpecificData: %w", err)
	}
	var n NodeSettings
	var err error
	field := func(key string, dst any) {
		if err != nil {
			return
		}
		v, ok := raw[key]
		if !ok || string(v) == "null" {
			return
		}
		if e := json.Unmarshal(v, dst); e != nil {
			err = fmt.Errorf("claudeprep: providerSpecificData.%s: %w", key, e)
		}
	}
	field("apiType", &n.APIType)
	field("baseUrl", &n.BaseURL)
	field("modelRoutes", &n.ModelRoutes)
	field("stripBeta", &n.StripBeta)
	field("authHeader", &n.AuthHeader)
	field("mimic", &n.Mimic)
	field("customHeaders", &n.CustomHeaders)
	field("blockForeignTools", &n.BlockForeignTools)
	field("stripReasoning", &n.StripReasoning)
	if v, ok := raw["droppedBetas"]; ok {
		if string(v) == "null" {
			return NodeSettings{}, fmt.Errorf("claudeprep: providerSpecificData.droppedBetas is null")
		}
		field("droppedBetas", &n.DroppedBetas)
		if n.DroppedBetas == nil {
			n.DroppedBetas = []string{}
		}
	}
	if v, ok := raw["overrides"]; ok && string(v) != "null" {
		var o map[string]json.RawMessage
		if e := json.Unmarshal(v, &o); e != nil {
			return NodeSettings{}, fmt.Errorf("claudeprep: providerSpecificData.overrides: %w", e)
		}
		n.Overrides = &Overrides{}
		for key, dst := range map[string]*string{
			"path": &n.Overrides.Path, "query": &n.Overrides.Query, "headers": &n.Overrides.Headers,
			"body": &n.Overrides.Body, "drop": &n.Overrides.Drop, "models": &n.Overrides.Models,
			"stream": &n.Overrides.Stream, "timeout": &n.Overrides.Timeout, "retries": &n.Overrides.Retries,
			"proxy": &n.Overrides.Proxy,
		} {
			if s, ok := o[key]; ok && string(s) != "null" {
				if e := json.Unmarshal(s, dst); e != nil {
					return NodeSettings{}, fmt.Errorf("claudeprep: providerSpecificData.overrides.%s: %w", key, e)
				}
			}
		}
	}
	// chatCore refuses a connection with a truthy blockedReason before any send.
	if v, ok := raw["blockedReason"]; ok {
		b, perr := Parse(v)
		n.Blocked = perr != nil || b.Truthy()
	}
	if err != nil {
		return NodeSettings{}, err
	}
	return n, nil
}
