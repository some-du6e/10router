// Package config reads the gateway's settings from the environment. Every
// default matches what the Node server does on its own today, so putting the
// gateway in front changes no timeout a client can observe.
package config

import (
	"errors"
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
	// body, and HeadersTimeout its headers: Node's defaults, which nothing in
	// this repo changes (0 turns either off).
	RequestTimeout time.Duration
	HeadersTimeout time.Duration
	// IdleTimeout is the public keep-alive timeout (KEEP_ALIVE_TIMEOUT).
	IdleTimeout time.Duration
	// PeerToken proves the gateway's peer headers to the Node server
	// (GATEWAY_PEER_TOKEN, at least MinPeerTokenLength characters). When the
	// gateway starts Node itself and none is set, it makes a random one.
	PeerToken string
	// TrustProxy is TRUST_PROXY, read by the client-IP rule.
	TrustProxy string
	// Shadow is GATEWAY_SHADOW=1 with GATEWAY_MODE=native (CI only): Node
	// serves every request, and the gateway compares the upstream request it
	// would send for each /v1/messages with the one Node sent. It never sends.
	Shadow bool

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
		other := c.ListenPort + 1
		if other > 65535 {
			other = c.ListenPort - 1
		}
		c.Warnings = append(c.Warnings, fmt.Sprintf("GATEWAY_APP_PORT=%d is the public port; using %d", c.AppPort, other))
		c.AppPort = other
	}
	var warn string
	c.DrainTimeout, warn = ParseDrainTimeout(getenv("SHUTDOWN_DRAIN_TIMEOUT_MS"))
	if warn != "" {
		c.Warnings = append(c.Warnings, warn)
	}
	c.RequestTimeout = DefaultRequestTimeout
	c.HeadersTimeout = DefaultHeadersTimeout
	c.IdleTimeout = ParseKeepAlive(getenv("KEEP_ALIVE_TIMEOUT"))
	c.PeerToken = strings.TrimSpace(getenv("GATEWAY_PEER_TOKEN"))
	c.TrustProxy = getenv("TRUST_PROXY")
	switch shadow := strings.TrimSpace(getenv("GATEWAY_SHADOW")); {
	case shadow == "" || shadow == "0":
	case shadow != "1":
		c.Warnings = append(c.Warnings, fmt.Sprintf("GATEWAY_SHADOW=%q is not 1 or 0; shadow compare off", shadow))
	case c.Mode != ModeNative:
		c.Warnings = append(c.Warnings, "GATEWAY_SHADOW=1 needs GATEWAY_MODE=native; shadow compare off")
	default:
		c.Shadow = true
	}
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

// MinPeerTokenLength is the shortest GATEWAY_PEER_TOKEN custom-server.js
// accepts. A shorter one would leave Node using its loopback socket for every
// request, so the gateway refuses to run with one.
const MinPeerTokenLength = 32

// ParseKeepAlive reads KEEP_ALIVE_TIMEOUT the way Next's standalone server.js
// does: parseInt (leading digits, "30000ms" is 30000), and anything that isn't
// a positive number of ms leaves the default.
func ParseKeepAlive(value string) time.Duration {
	text := strings.TrimLeft(value, " \t\n\r\v\f")
	end := 0
	if end < len(text) && (text[0] == '+' || text[0] == '-') {
		end++
	}
	start := end
	for end < len(text) && text[end] >= '0' && text[end] <= '9' {
		end++
	}
	if end == start {
		return DefaultKeepAliveTimeout
	}
	n, err := strconv.ParseInt(text[:end], 10, 64)
	if err != nil || n <= 0 || n > maxDrainTimeoutMs {
		return DefaultKeepAliveTimeout
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
	n, err := strconv.ParseUint(text, 10, 64)
	if errors.Is(err, strconv.ErrSyntax) {
		return DefaultDrainTimeout, fmt.Sprintf("SHUTDOWN_DRAIN_TIMEOUT_MS=%q is not a whole number of ms; using %d", value, DefaultDrainTimeout.Milliseconds())
	}
	if err != nil || n > maxDrainTimeoutMs {
		// Past uint64 (ErrRange) is past the ceiling too.
		n = maxDrainTimeoutMs
	}
	return time.Duration(n) * time.Millisecond, ""
}
