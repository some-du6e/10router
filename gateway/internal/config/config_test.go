package config

import (
	"testing"
	"time"
)

func TestParseMode(t *testing.T) {
	for value, want := range map[string]Mode{"": ModeOff, "off": ModeOff, " OFF ": ModeOff, "proxy": ModeProxy, "Proxy": ModeProxy, "native": ModeNative} {
		if got, ok := ParseMode(value); got != want || !ok {
			t.Errorf("ParseMode(%q) = %q, %v", value, got, ok)
		}
	}
	// Unknown means the app server alone.
	if got, ok := ParseMode("turbo"); got != ModeOff || ok {
		t.Errorf("ParseMode(turbo) = %q, %v", got, ok)
	}
}

// The cases server-drain.js's parseDrainTimeout is tested with.
func TestParseDrainTimeout(t *testing.T) {
	for value, want := range map[string]time.Duration{
		"": DefaultDrainTimeout, "  ": DefaultDrainTimeout, "0": 0, "off": 0, "OFF": 0, "false": 0, "00": 0,
		"5000": 5 * time.Second, " 250 ": 250 * time.Millisecond,
		"99999999999": 2147483647 * time.Millisecond, "99999999999999999999999": 2147483647 * time.Millisecond,
	} {
		got, warn := ParseDrainTimeout(value)
		if got != want || warn != "" {
			t.Errorf("ParseDrainTimeout(%q) = %v, %q; want %v", value, got, warn, want)
		}
	}
	for _, value := range []string{"3m", "-1", "1.5", "abc"} {
		got, warn := ParseDrainTimeout(value)
		if got != DefaultDrainTimeout || warn == "" {
			t.Errorf("ParseDrainTimeout(%q) = %v, %q; want the default with a warning", value, got, warn)
		}
	}
}

func env(m map[string]string) func(string) string { return func(k string) string { return m[k] } }

func TestLoadDefaultsMatchNode(t *testing.T) {
	c := Load(env(nil))
	if c.Mode != ModeOff || c.ListenHost != "0.0.0.0" || c.ListenPort != 20128 || c.AppPort != 20129 {
		t.Errorf("listen %+v", c)
	}
	if c.DrainTimeout != 180*time.Second || c.RequestTimeout != 300*time.Second || c.HeadersTimeout != 60*time.Second || c.IdleTimeout != 5*time.Second {
		t.Errorf("timeouts %+v", c)
	}
	if len(c.Warnings) != 0 {
		t.Errorf("warnings %v", c.Warnings)
	}
}

func TestLoad(t *testing.T) {
	c := Load(env(map[string]string{
		"GATEWAY_MODE": "proxy", "HOSTNAME": "::", "PORT": "8080", "GATEWAY_APP_PORT": "8080",
		"KEEP_ALIVE_TIMEOUT": "65000", "SHUTDOWN_DRAIN_TIMEOUT_MS": "off", "TRUST_PROXY": "10.0.0.0/8",
	}))
	if c.Mode != ModeProxy || c.ListenHost != "::" || c.ListenPort != 8080 || c.AppPort != 8081 {
		t.Errorf("%+v", c)
	}
	if c.IdleTimeout != 65*time.Second || c.DrainTimeout != 0 || c.TrustProxy != "10.0.0.0/8" {
		t.Errorf("%+v", c)
	}
	if len(c.Warnings) != 1 {
		t.Errorf("want one warning (the port clash), got %v", c.Warnings)
	}
	if top := Load(env(map[string]string{"PORT": "65535", "GATEWAY_APP_PORT": "65535"})); top.AppPort != 65534 {
		t.Errorf("port clash at 65535: app port %d", top.AppPort)
	}
	bad := Load(env(map[string]string{"GATEWAY_MODE": "fast", "PORT": "http", "KEEP_ALIVE_TIMEOUT": "-5"}))
	if bad.Mode != ModeOff || bad.ListenPort != 20128 || bad.IdleTimeout != 5*time.Second || len(bad.Warnings) != 2 {
		t.Errorf("%+v", bad)
	}
}

// Next's standalone server.js: parseInt, and only a positive value counts.
func TestParseKeepAlive(t *testing.T) {
	for value, want := range map[string]time.Duration{
		"": 5 * time.Second, "0": 5 * time.Second, "-5": 5 * time.Second, "abc": 5 * time.Second, "+": 5 * time.Second,
		"65000": 65 * time.Second, " 30000ms": 30 * time.Second, "+7000": 7 * time.Second, "1.5": time.Millisecond,
	} {
		if got := ParseKeepAlive(value); got != want {
			t.Errorf("ParseKeepAlive(%q) = %v, want %v", value, got, want)
		}
	}
}
