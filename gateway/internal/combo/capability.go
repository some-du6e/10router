package combo

import (
	"strings"

	"github.com/some-du6e/10router/gateway/internal/claudeprep"
)

// MayNeedCapability is combo.js's detectRequiredCapabilities(body).size > 0,
// answered on the safe side: true whenever Node's set could be non-empty.
// Which member serves such a request depends on model capabilities (the
// capacity adapter, the auto-switch reorder), which Node reads from its model
// catalog; until that is ported the request is Node's.
//
// It looks at what Node scans: the current user turn (the messages after the
// last assistant one) for images, PDFs, audio, video, files, attachments and
// data URIs, and the tools for a search type. A body carrying another
// format's turns (`input`, `contents`, `request`) is declined: Node scans
// those too, and throws on some.
func MayNeedCapability(body *claudeprep.Value) (bool, error) {
	if !body.IsObject() {
		return false, nil
	}
	if in := body.Get("input"); in.IsArray() && len(in.Items()) > 0 {
		return false, declined("a body with an input array (another API format's turns)")
	}
	if body.Get("contents").Truthy() || !body.Get("request").IsNullish() {
		return false, declined("a body with contents or a request envelope (another API format's turns)")
	}
	for _, m := range trailingUserItems(body.Get("messages")) {
		if messageMayNeed(m) {
			return true, nil
		}
	}
	if tools := body.Get("tools"); tools.IsArray() {
		for _, t := range tools.Items() {
			if t.IsObject() {
				if typ := t.Get("type"); typ.IsString() && searchToolType[typ.Str()] {
					return true, nil
				}
			}
		}
	}
	return false, nil
}

// searchToolType is SEARCH_TOOL_TYPES (filled when tables.json is read).
var searchToolType = map[string]bool{}

// role is v?.role for a value Node may read it on.
func role(v *claudeprep.Value) *claudeprep.Value {
	if v.IsObject() {
		return v.Get("role")
	}
	return claudeprep.Undefined()
}

// trailingUserItems is combo.js's: the items after the last assistant or
// model turn.
func trailingUserItems(arr *claudeprep.Value) []*claudeprep.Value {
	if !arr.IsArray() {
		return nil
	}
	items := arr.Items()
	i := len(items) - 1
	for i >= 0 {
		if r := role(items[i]); r.Is("assistant") || r.Is("model") {
			break
		}
		i--
	}
	return items[i+1:]
}

// Block types scanBlock maps to a capability, and the file types it infers
// one for (or, with an unknown mime type, none: counted here anyway).
var capabilityBlockTypes = map[string]bool{
	"image_url": true, "image": true, "input_image": true,
	"input_audio": true, "audio_url": true, "audio": true,
	"input_video": true, "video_url": true, "video": true,
	"file": true, "document": true, "input_file": true,
}

var dataURIMarkers = []string{"data:image/", "data:audio/", "data:application/pdf"}

// messageMayNeed is scanMessage on one message, on the safe side.
func messageMayNeed(m *claudeprep.Value) bool {
	if !m.IsObject() {
		return false
	}
	if imgs := m.Get("images"); imgs.IsArray() && len(imgs.Items()) > 0 {
		return true
	}
	att := m.Get("experimental_attachments")
	if !att.Truthy() {
		att = m.Get("attachments")
	}
	if att.IsArray() {
		for _, a := range att.Items() {
			if a.Truthy() {
				return true
			}
		}
	}
	for _, k := range []string{"image_url", "image", "audio_url", "audio"} {
		if m.Get(k).Truthy() {
			return true
		}
	}
	content := m.Get("content")
	if content.IsArray() {
		for _, b := range content.Items() {
			if !b.IsObject() {
				continue
			}
			if t := b.Get("type"); t.IsString() && capabilityBlockTypes[t.Str()] {
				return true
			}
			if b.Get("inlineData").Truthy() || b.Get("fileData").Truthy() {
				return true
			}
		}
	}
	if content.IsString() {
		for _, mark := range dataURIMarkers {
			if strings.Contains(content.Str(), mark) {
				return true
			}
		}
	}
	return false
}
