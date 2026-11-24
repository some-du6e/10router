// Package config reads the gateway's settings from the environment. Every
// default matches what the Node server does on its own today, so putting the
// gateway in front changes no timeout a client can observe.
package config

import (
	"fmt"
	"strconv"
	"strings"
	"time"
)

// Mode is GATEWAY_MODE.
type Mode string

const (
	// ModeOff runs the Node server alone on the public port, as before the
	// gateway existed. The default.
	ModeOff Mode = "off"
	// ModeProxy puts the gateway on the public port and relays every request
	// to the Node server on a loopback port.
	ModeProxy Mode = "proxy"
	// ModeNative is proxy mode plus the routes the gateway serves itself. This
	// build has none, so it behaves exactly like ModeProxy.
	ModeNative Mode = "native"
)

// ParseMode reads GATEWAY_MODE. Empty is off. A value it doesn't know is off
// too, with ok false so the caller can say so: when in doubt, run Node alone.
func ParseMode(value string) (mode Mode, ok bool) {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "", "off", "false", "0":
		return ModeOff, true
	case "proxy":
		return ModeProxy, true
	case "native":
		return ModeNative, true
	default:
		return ModeOff, false
	}
}

const (
	// DefaultDrainTimeout is server-drain.js's DEFAULT_DRAIN_TIMEOUT_MS.
	DefaultDrainTimeout = 180 * time.Second
	// maxDrainTimeoutMs is server-drain.js's MAX_DRAIN_TIMEOUT_MS (setTimeout's ceiling).
	maxDrainTimeoutMs = 2147483647
	// DefaultRequestTimeout is Node's own server.requestTimeout default: the
	// time a client has to send the whole request, body included.
	DefaultRequestTimeout = 300 * time.Second
	// DefaultHeadersTimeout is Node's server.headersTimeout default.
	DefaultHeadersTimeout = 60 * time.Second
	// DefaultKeepAliveTimeout is Node's server.keepAliveTimeout default, which
	// Next's standalone server.js replaces with KEEP_ALIVE_TIMEOUT when set.
	DefaultKeepAliveTimeout = 5 * time.Second
	// DefaultAppPort is the loopback port the Node server moves to.
	DefaultAppPort = 20129
	// DefaultPublicPort is the port the Dockerfile gives the Node server today.
	DefaultPublicPort = 20128
	// AppKeepAliveTimeout is the keep-alive the gateway gives the Node server
	// on the loopback hop, and appIdleConnTimeout is how long the gateway keeps
	// an idle connection to it. The gateway always lets go first, so it never
	// sends a request on a connection Node is closing at that moment (a POST
	// lost that way can't be retried).
	AppKeepAliveTimeout = 30 * time.Second
	AppIdleConnTimeout  = 20 * time.Second
)

// Config is everything the gateway reads from the environment.
type Config struct {
	Mode Mode
	// Listen is host:port for the public listener (HOSTNAME and PORT, which
	// the Node server would have used).
	ListenHost string
	ListenPort int
	// AppPort is the Node server's loopback port (GATEWAY_APP_PORT).
	AppPort int
	// DrainTimeout is SHUTDOWN_DRAIN_TIMEOUT_MS, parsed as server-drain.js does.
	// Zero means no drain: a signal stops at once.
	DrainTimeout time.Duration
	// RequestTimeout bounds how long a client may take to send its request
	// body (GATEWAY_REQUEST_TIMEOUT_MS; 0 turns it off, as for Node).
	RequestTimeout time.Duration
	// HeadersTimeout bounds how long a client may take to send its headers.
	HeadersTimeout time.Duration
	// IdleTimeout is the public keep-alive timeout (KEEP_ALIVE_TIMEOUT).
	IdleTimeout time.Duration
	// PeerToken proves the gateway's peer headers to the Node server
	// (GATEWAY_PEER_TOKEN). When the gateway starts Node itself and none is
	// set, it makes a random one.
	PeerToken string
	// TrustProxy is TRUST_PROXY, read by the client-IP rule.
	TrustProxy string

	Warnings []string
}

// Load reads the environment through getenv.
func Load(getenv func(string) string) Config {
	c := Config{}
	var ok bool
	c.Mode, ok = ParseMode(getenv("GATEWAY_MODE"))
	if !ok {
		c.Warnings = append(c.Warnings, fmt.Sprintf("GATEWAY_MODE=%q is not off, proxy or native; running the app server alone", getenv("GATEWAY_MODE")))
	}
	c.ListenHost = strings.TrimSpace(getenv("HOSTNAME"))
	if c.ListenHost == "" {
		// Next's standalone server.js default.
		c.ListenHost = "0.0.0.0"
	}
	c.ListenPort = c.port(getenv, "PORT", DefaultPublicPort)
	c.AppPort = c.port(getenv, "GATEWAY_APP_PORT", DefaultAppPort)
	if c.AppPort == c.ListenPort {
		c.Warnings = append(c.Warnings, fmt.Sprintf("GATEWAY_APP_PORT=%d is the public port; using %d", c.AppPort, c.ListenPort+1))
		c.AppPort = c.ListenPort + 1
	}
	var warn string
	c.DrainTimeout, warn = ParseDrainTimeout(getenv("SHUTDOWN_DRAIN_TIMEOUT_MS"))
	if warn != "" {
		c.Warnings = append(c.Warnings, warn)
	}
	c.RequestTimeout = c.millis(getenv, "GATEWAY_REQUEST_TIMEOUT_MS", DefaultRequestTimeout)
	c.HeadersTimeout = c.millis(getenv, "GATEWAY_HEADERS_TIMEOUT_MS", DefaultHeadersTimeout)
	c.IdleTimeout = c.millis(getenv, "KEEP_ALIVE_TIMEOUT", DefaultKeepAliveTimeout)
	c.PeerToken = strings.TrimSpace(getenv("GATEWAY_PEER_TOKEN"))
	c.TrustProxy = getenv("TRUST_PROXY")
	return c
}

func (c *Config) port(getenv func(string) string, name string, fallback int) int {
	raw := strings.TrimSpace(getenv(name))
	if raw == "" {
		return fallback
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n <= 0 || n > 65535 {
		c.Warnings = append(c.Warnings, fmt.Sprintf("%s=%q is not a port; using %d", name, raw, fallback))
		return fallback
	}
	return n
}

func (c *Config) millis(getenv func(string) string, name string, fallback time.Duration) time.Duration {
	raw := strings.TrimSpace(getenv(name))
	if raw == "" {
		return fallback
	}
	n, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || n < 0 || n > maxDrainTimeoutMs {
		c.Warnings = append(c.Warnings, fmt.Sprintf("%s=%q is not a whole number of ms; using %d", name, raw, fallback.Milliseconds()))
		return fallback
	}
	return time.Duration(n) * time.Millisecond
}

// ParseDrainTimeout is server-drain.js's parseDrainTimeout: empty is the
// default, "0"/"off"/"false" turn the drain off, digits are milliseconds
// capped at setTimeout's ceiling, and anything else is the default with a
// warning.
func ParseDrainTimeout(value string) (time.Duration, string) {
	text := strings.ToLower(strings.TrimSpace(value))
	switch text {
	case "":
		return DefaultDrainTimeout, ""
	case "0", "off", "false":
		return 0, ""
	}
	digits := true
	for _, r := range text {
		if r < '0' || r > '9' {
			digits = false
			break
		}
	}
	if !digits {
		return DefaultDrainTimeout, fmt.Sprintf("SHUTDOWN_DRAIN_TIMEOUT_MS=%q is not a whole number of ms; using %d", value, DefaultDrainTimeout.Milliseconds())
	}
	n, err := strconv.ParseUint(text, 10, 64)
	if err != nil || n > maxDrainTimeoutMs {
		// More digits than uint64 holds is past the ceiling too.
		n = maxDrainTimeoutMs
	}
	return time.Duration(n) * time.Millisecond, ""
}
