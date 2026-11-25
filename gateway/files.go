// Package gatewayfiles embeds the files at the module root that the gateway
// reads at run time: GATEWAY_PROXY_ONLY and node-map.json (docs/GO_GATEWAY.md,
// Risks, "Drift as Node changes").
//
// A package listed in GATEWAY_PROXY_ONLY has a Node change its port hasn't
// caught up with. Every mapped package sits on the native /v1/messages path,
// so any listed one keeps that whole route proxied to Node.
//
// Only native mode needs either file. The answer is worked out once, at
// process start in every mode, so nothing here may fail the process: a file
// that can't be read turns native off with a reason, and proxy mode serves on.
//
// It sits at the module root, under a name other than the directory's,
// because //go:embed reads only files in or below a package's directory and
// both files belong at the root, where the drift check reads them.
package gatewayfiles

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"slices"
	"sort"
	"strings"
)

//go:embed GATEWAY_PROXY_ONLY
var proxyOnlyText string

//go:embed node-map.json
var nodeMapJSON []byte

// ProxyOnly is the packages GATEWAY_PROXY_ONLY lists, in its order.
func ProxyOnly() []string { return parseProxyOnly(proxyOnlyText) }

func parseProxyOnly(text string) []string {
	var out []string
	for _, line := range strings.Split(text, "\n") {
		line = strings.TrimSpace(line)
		if line != "" && !strings.HasPrefix(line, "#") {
			out = append(out, line)
		}
	}
	return out
}

// MappedPackages is node-map.json's packages, sorted, or why the map can't
// be read.
func MappedPackages() ([]string, error) { return parseNodeMap(nodeMapJSON) }

func parseNodeMap(data []byte) ([]string, error) {
	var m map[string]json.RawMessage
	if err := json.Unmarshal(data, &m); err != nil {
		return nil, fmt.Errorf("node-map.json: %w", err)
	}
	var out []string
	for k := range m {
		if !strings.HasPrefix(k, "_") {
			out = append(out, k)
		}
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("node-map.json maps no packages")
	}
	sort.Strings(out)
	return out, nil
}

// NativeOff is why the native route stays proxied, or "" when nothing keeps
// it so. Both files are embedded, so the answer is worked out once.
func NativeOff() string { return nativeOffReason }

var nativeOffReason = NativeOffFor(proxyOnlyText, nodeMapJSON)

// NativeOffFor is NativeOff for the given GATEWAY_PROXY_ONLY text and
// node-map.json bytes. A map that can't be read turns native off: the port
// can't tell which packages it holds to Node, so it serves none of them. A
// listed name that isn't a mapped package counts too: when in doubt, proxy.
func NativeOffFor(proxyOnly string, nodeMap []byte) string {
	mapped, err := parseNodeMap(nodeMap)
	if err != nil {
		return fmt.Sprintf("the embedded %v; native routes stay off", err)
	}
	return nativeOff(parseProxyOnly(proxyOnly), mapped)
}

func nativeOff(listed, mapped []string) string {
	if len(listed) == 0 {
		return ""
	}
	var unknown []string
	for _, p := range listed {
		if !slices.Contains(mapped, p) {
			unknown = append(unknown, p)
		}
	}
	reason := fmt.Sprintf("GATEWAY_PROXY_ONLY lists %s, whose Node code changed without the port", strings.Join(listed, ", "))
	if len(unknown) > 0 {
		reason += fmt.Sprintf(" (%s is not a package in node-map.json)", strings.Join(unknown, ", "))
	}
	return reason
}
