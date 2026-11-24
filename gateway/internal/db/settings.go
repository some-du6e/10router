package db

import (
	"regexp"
	"strings"

	"github.com/some-du6e/10router/gateway/internal/db/jsjson"
)

// defaultSettingsJSON is settingsRepo.js's DEFAULT_SETTINGS, in its order.
// tests/unit/gateway-db-parity.test.js compares Settings built from an empty
// row with Node's getSettings(), so a default added there fails CI until it
// is here too.
const defaultSettingsJSON = `{
  "usageHubEnabled": false,
  "cloudEnabled": false,
  "tunnelEnabled": false,
  "tunnelUrl": "",
  "tunnelProvider": "cloudflare",
  "tailscaleEnabled": false,
  "tailscaleUrl": "",
  "stickyRoundRobinLimit": 3,
  "codexSessionAffinity": false,
  "limitHoldEnabled": false,
  "limitHoldOnPinned": false,
  "providerStrategies": {},
  "quotaVisibility": {},
  "comboStrategy": "fallback",
  "comboStickyRoundRobinLimit": 1,
  "comboStrategies": {},
  "autoComboBlockedBilling": ["payg", "freeTier", "custom"],
  "autoComboExcludedProviders": [],
  "capacityAdapter": {
    "vision": { "enabled": true, "roundRobin": false, "models": [] },
    "pdf": { "enabled": false, "roundRobin": false, "models": [] },
    "audioInput": { "enabled": true, "roundRobin": false, "models": [] },
    "videoInput": { "enabled": false, "roundRobin": false, "models": [] }
  },
  "requireLogin": true,
  "requireApiKey": true,
  "tunnelDashboardAccess": true,
  "authMode": "password",
  "ssoType": "oidc",
  "oidcIssuerUrl": "",
  "oidcClientId": "",
  "oidcClientSecret": "",
  "oidcScopes": "openid profile email",
  "oidcLoginLabel": "Sign in with OIDC",
  "samlEntryPoint": "",
  "samlIssuer": "urn:9router:sp",
  "samlCert": "",
  "samlLoginLabel": "Sign in with SAML SSO",
  "samlAttributeEmail": "email",
  "samlAttributeName": "name",
  "enableObservability": false,
  "legacyProvidersView": false,
  "showSensitiveRequestDetails": false,
  "observabilityMaxRecords": 1000,
  "observabilityBatchSize": 20,
  "observabilityFlushIntervalMs": 5000,
  "observabilityMaxJsonSize": 5,
  "outboundProxyEnabled": false,
  "outboundProxyUrl": "",
  "outboundNoProxy": ""
}`

var defaultSettings = func() *jsjson.Object {
	o, err := jsjson.ParseObject([]byte(defaultSettingsJSON))
	if err != nil {
		panic(err)
	}
	return o
}()

// retiredTokenSaver is retiredSettings.js's RETIRED_TOKEN_SAVER.
var retiredTokenSaver = regexp.MustCompile(`^(rtk|headroom|caveman|ponytail|pxpipe)[A-Z]`)

func retiredSetting(key string) bool {
	return strings.HasPrefix(key, "mitm") || key == "dnsToolEnabled" || retiredTokenSaver.MatchString(key)
}

// Settings is getSettings(): the stored row over DEFAULT_SETTINGS, retired
// keys dropped (mergeWithDefaults).
type Settings struct {
	// Merged holds every key, in the order Node's merged object has them.
	Merged *jsjson.Object
}

// mergeSettings is mergeWithDefaults(raw).
func mergeSettings(raw *jsjson.Object) Settings {
	merged := defaultSettings.Clone()
	for _, m := range raw.Members() {
		if retiredSetting(m.Key) {
			continue
		}
		merged.Set(m.Key, jsjson.CloneValue(m.Value))
	}
	return Settings{Merged: merged}
}

// Get is the setting's value (nil, false when absent).
func (s Settings) Get(key string) (any, bool) { return s.Merged.Get(key) }

// Bool is the setting as a boolean: true only for a stored true, as Node's
// `settings.x === true` checks read it.
func (s Settings) Bool(key string) bool {
	v, _ := s.Merged.Get(key)
	b, _ := v.(bool)
	return b
}

// Truthy is the setting's JavaScript truthiness (`if (settings.x)`).
func (s Settings) Truthy(key string) bool {
	v, _ := s.Merged.Get(key)
	return jsjson.Truthy(v)
}

// String is the setting when it is a string, else "".
func (s Settings) String(key string) string {
	v, _ := s.Merged.Get(key)
	str, _ := v.(string)
	return str
}

// Number is the setting when it is a number.
func (s Settings) Number(key string) (float64, bool) {
	v, _ := s.Merged.Get(key)
	f, ok := v.(float64)
	return f, ok
}

// Object is the setting when it is an object.
func (s Settings) Object(key string) *jsjson.Object {
	v, _ := s.Merged.Get(key)
	o, _ := v.(*jsjson.Object)
	return o
}
