// Package gateway wires the pieces together: the public listener, the drain,
// the proxy to the app server, the app server itself as a child process, and
// the shutdown signals.
package gateway

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"log"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"os"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	gatewayfiles "github.com/some-du6e/10router/gateway"
	"github.com/some-du6e/10router/gateway/internal/clientip"
	"github.com/some-du6e/10router/gateway/internal/config"
	"github.com/some-du6e/10router/gateway/internal/db"
	"github.com/some-du6e/10router/gateway/internal/drain"
	"github.com/some-du6e/10router/gateway/internal/native"
	"github.com/some-du6e/10router/gateway/internal/nodeevents"
	"github.com/some-du6e/10router/gateway/internal/proxy"
	"github.com/some-du6e/10router/gateway/internal/route"
	"github.com/some-du6e/10router/gateway/internal/shadow"
	"github.com/some-du6e/10router/gateway/internal/supervisor"
)

// HealthPath is the gateway's own health endpoint. It never reaches the app.
const HealthPath = "/_gateway/health"

// Timings from server-drain.js.
const (
	// DuplicateSignalWindow: a repeat of the signal this soon is the same stop
	// arriving twice (npm, a supervisor and a kill can each send one).
	DuplicateSignalWindow = 1500 * time.Millisecond
	// ExitFlush: grace after the last request ends, so its final bytes leave.
	ExitFlush = 200 * time.Millisecond
	// ListenerWait: what the app server's own shutdown listeners get after its
	// drain ends. The gateway's deadline is the app's plus this and a second.
	ListenerWait = 2 * time.Second
)

// Options for Run.
type Options struct {
	Config config.Config
	// Command is the app server to start (e.g. node custom-server.js). The
	// binary always passes one; empty (tests only) relays to an app server
	// already listening on Config.AppPort.
	Command []string
	Env     []string
	Signals <-chan os.Signal
	Logger  *log.Logger
	Version string
	// Listener, when set, is used instead of listening on Config's address.
	Listener net.Listener
	// OnListening is called with the public address once it accepts (tests).
	OnListening func(addr string)
	// PassOn are the signals handed to the app server (PassOnSignals);
	// nil means SIGUSR1 only.
	PassOn []os.Signal
}

// maxHeaderBytes caps a client's headers at about Node's --max-http-header-size
// (16 KiB unless NODE_OPTIONS or the node command line sets it): net/http
// allows MaxHeaderBytes plus 4096 bytes of slack. custom-server.js gives its
// server 4 KiB more than that behind the gateway, room for the peer headers,
// so the gateway is the one that answers 431.
func maxHeaderBytes(nodeOptions string, command []string) int {
	size := nodeHeaderSize(strings.Fields(nodeOptions), 16<<10)
	// Node's own flags, between "node" and the script, win over NODE_OPTIONS.
	if len(command) > 1 {
		size = nodeHeaderSize(nodeFlags(command[1:]), size)
	}
	// net/http never allows less than its 4 KiB of slack.
	return max(size-4<<10, 1)
}

// Node flags that take their value as the next argument, as used to start an
// app server; the value is not the script.
var nodeValueFlags = map[string]bool{
	"--max-http-header-size": true, "-r": true, "--require": true, "--import": true, "--loader": true,
	"--experimental-loader": true, "--env-file": true, "--env-file-if-exists": true, "--title": true,
	"--inspect-port": true, "--heapsnapshot-signal": true, "--report-signal": true, "-C": true, "--conditions": true,
	"--disable-warning": true, "--dns-result-order": true, "--unhandled-rejections": true, "--input-type": true,
	"--redirect-warnings": true, "--report-dir": true, "--report-directory": true, "--diagnostic-dir": true,
	"--openssl-config": true, "--icu-data-dir": true, "--secure-heap": true,
}

// nodeFlags is args up to the script: every leading "-" argument, and the
// value after one of nodeValueFlags.
func nodeFlags(args []string) []string {
	for i := 0; i < len(args); i++ {
		a := args[i]
		if !strings.HasPrefix(a, "-") {
			return args[:i]
		}
		if !strings.Contains(a, "=") && nodeValueFlags[strings.ReplaceAll(a, "_", "-")] {
			i++
		}
	}
	return args
}

// nodeHeaderSize is the last --max-http-header-size in args, spelled any way
// Node accepts (underscores, "=" or a separate value, quotes), else size.
func nodeHeaderSize(args []string, size int) int {
	for i, a := range args {
		name, value, hasValue := strings.Cut(a, "=")
		if strings.ReplaceAll(name, "_", "-") != "--max-http-header-size" {
			continue
		}
		if !hasValue {
			if i+1 >= len(args) {
				continue
			}
			value = args[i+1]
		}
		if n, err := strconv.Atoi(strings.Trim(value, `"'`)); err == nil && n > 0 {
			size = n
		}
	}
	return size
}

// SignalSettle is how long the gateway waits after it stops admitting
// requests before it passes the signal on to the app server. A request
// admitted just before then has reached Node by the time Node's own drain
// closes its listener and idle connections.
const SignalSettle = 250 * time.Millisecond

// Gateway is the public-facing handler.
type Gateway struct {
	cfg        config.Config
	logger     *log.Logger
	tracker    *drain.Tracker
	proxy      *proxy.Proxy
	rule       *clientip.Rule
	listenIPv6 bool
	appAddr    string
	version    string
	startedAt  time.Time

	pass []os.Signal

	healthMu    sync.Mutex
	healthAt    time.Time
	healthAppUp bool

	// native is the database the native routes would read, in native mode
	// only (nil until it opens). nativeErr is why it didn't open.
	nativeMu     sync.Mutex
	native       *db.DB
	nativeErr    string
	nativeClosed bool
	// nativeRoute is the native /v1/messages over native (nil until then).
	nativeRoute *native.Native

	// shadow is the shadow compare (GATEWAY_SHADOW=1), nil when off.
	shadow *shadow.Shadow

	// nativeOff is gatewayfiles.NativeOff (tests replace it).
	nativeOff func() string
}

// nativeStatus is what health reports for the native routes: ready, or why not.
func (g *Gateway) nativeStatus() (ready bool, reason string) {
	// A port behind its Node code, or a map the gateway can't read, keeps the
	// native route proxied.
	if off := g.nativeOff(); off != "" {
		return false, off
	}
	// A package whose embedded tables didn't load reports it here.
	if err := native.Ready(); err != nil {
		return false, err.Error()
	}
	g.nativeMu.Lock()
	d, openErr := g.native, g.nativeErr
	g.nativeMu.Unlock()
	if d == nil {
		if openErr == "" {
			openErr = "the database has not been opened yet"
		}
		return false, openErr
	}
	st := d.Status()
	if !st.Ready && st.CheckedAt.IsZero() {
		// The first poll failed before the guard ran: say why.
		if e := d.LastError(); e != "" {
			return false, st.Reason + ": " + e
		}
	}
	if st.Ready && d.Snapshot() == nil {
		reason := "the config snapshot has not loaded"
		if e := d.LastError(); e != "" {
			reason += ": " + e
		}
		return false, reason
	}
	return st.Ready, st.Reason
}

// readyRoute is the native route when it is ready, else nil and why not.
func (g *Gateway) readyRoute() (*native.Native, string) {
	if ready, reason := g.nativeStatus(); !ready {
		return nil, reason
	}
	g.nativeMu.Lock()
	defer g.nativeMu.Unlock()
	if g.nativeRoute == nil {
		return nil, "the native route has not been built"
	}
	return g.nativeRoute, ""
}

// nativeRetry is how often a database that didn't open is tried again.
const nativeRetry = time.Second

// openNative opens the app server's database, checks the schema and keeps
// the config snapshot current. Node opens (and on a fresh install creates
// and migrates) its database on its first use of it, which can come after
// it listens, so a file that isn't there yet is tried again every
// nativeRetry until ctx ends. Native mode serves no route yet, so this only
// feeds health and the log.
func (g *Gateway) openNative(ctx context.Context, env []string) {
	getenv := os.Getenv
	if env != nil {
		getenv = func(k string) string { return envValue(env, k) }
	}
	if g.tryOpenNative(ctx, getenv) {
		return
	}
	go func() {
		t := time.NewTicker(nativeRetry)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				if g.tryOpenNative(ctx, getenv) {
					return
				}
			}
		}
	}()
}

func (g *Gateway) tryOpenNative(ctx context.Context, getenv func(string) string) bool {
	path, err := db.DataFile(getenv)
	if err == nil {
		var d *db.DB
		if d, err = db.Open(path, db.Options{}); err == nil {
			var lastErr string
			err = d.Watch(ctx, db.WatchOptions{
				OnStatus: func(st db.Status) {
					if st.Ready {
						g.logger.Printf("[Gateway] native: database ready (schema %d, %s)", st.SchemaVersion, st.Driver)
					} else {
						g.logger.Printf("[Gateway] native routes off: %s", st.Reason)
					}
				},
				// One line per distinct error, not one per 250 ms poll; an error
				// that comes back after a good reload is logged again.
				OnReload: func(*db.Snapshot) { lastErr = "" },
				OnError: func(err error) {
					if msg := err.Error(); msg != lastErr {
						lastErr = msg
						g.logger.Printf("[Gateway] native: reading the database failed: %s", msg)
					}
				},
			})
			if err == nil {
				nr := native.New(d, g.rule, getenv, native.CatalogFile(path))
				nr.Events = nodeevents.New(g.cfg.AppPort, g.cfg.PeerToken)
				nr.Logger = g.logger
				g.nativeMu.Lock()
				g.native = d
				g.nativeRoute = nr
				g.nativeErr = ""
				closed := g.nativeClosed
				g.nativeMu.Unlock()
				if closed {
					_ = d.Close()
				}
				return true
			}
			_ = d.Close()
		}
	}
	reason := "cannot open the database: " + err.Error()
	g.nativeMu.Lock()
	changed := g.nativeErr != reason
	g.nativeErr = reason
	g.nativeMu.Unlock()
	if changed {
		g.logger.Printf("[Gateway] native routes off: %s (trying again every %v)", reason, nativeRetry)
	}
	return false
}

func (g *Gateway) closeNative() {
	g.nativeMu.Lock()
	d := g.native
	g.native = nil
	g.nativeRoute = nil
	g.nativeClosed = true
	g.nativeMu.Unlock()
	if d != nil {
		_ = d.Close()
	}
}

// New builds the handler for cfg.
func New(cfg config.Config, logger *log.Logger, version string) *Gateway {
	appAddr := net.JoinHostPort("127.0.0.1", strconv.Itoa(cfg.AppPort))
	listenIPv6 := false
	if a, err := netip.ParseAddr(cfg.ListenHost); err == nil && a.Is6() && !a.Is4In6() {
		listenIPv6 = true
	}
	g := &Gateway{
		cfg:        cfg,
		logger:     logger,
		tracker:    drain.NewTracker(),
		rule:       clientip.NewRule(cfg.TrustProxy),
		listenIPv6: listenIPv6,
		appAddr:    appAddr,
		version:    version,
		startedAt:  time.Now(),
		nativeOff:  gatewayfiles.NativeOff,
		proxy: proxy.New(proxy.Options{
			Upstream:       &url.URL{Scheme: "http", Host: appAddr},
			PeerToken:      cfg.PeerToken,
			RequestTimeout: cfg.RequestTimeout,
			ListenIPv6:     listenIPv6,
			Transport:      proxy.NewTransport(config.AppIdleConnTimeout),
			Logger:         logger,
		}),
	}
	if cfg.Shadow {
		g.shadow = &shadow.Shadow{Native: g.readyRoute, Token: cfg.PeerToken, Logger: logger}
	}
	return g
}

// ShadowURL is where the Node server reports its sends in shadow mode: the
// gateway's own port on 127.0.0.1 or ::1 (custom-server.js takes no other).
// "" unless the gateway listens on every address or on that one: a name, or
// another address, may not be reachable there.
func ShadowURL(cfg config.Config) string {
	a, err := netip.ParseAddr(cfg.ListenHost)
	host := ""
	switch {
	case err != nil:
	case a.IsUnspecified(), a.Unmap() == netip.AddrFrom4([4]byte{127, 0, 0, 1}):
		host = "127.0.0.1"
	case a == netip.IPv6Loopback():
		host = "::1"
	}
	if host == "" {
		return ""
	}
	return "http://" + net.JoinHostPort(host, strconv.Itoa(cfg.ListenPort)) + shadow.ReportPath
}

// listenNetwork is "tcp4" for an IPv4 address such as the default 0.0.0.0:
// Go's "tcp" on 0.0.0.0 opens a dual-stack socket, where Node listened on
// IPv4 only.
func listenNetwork(host string) string {
	if a, err := netip.ParseAddr(host); err == nil && a.Is4() {
		return "tcp4"
	}
	return "tcp"
}

// ServeHTTP serves the health endpoint and relays everything else.
func (g *Gateway) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path == HealthPath && (r.Method == http.MethodGet || r.Method == http.MethodHead) {
		g.health(w, r)
		return
	}
	// Node's reports in shadow mode; the path is Node's otherwise.
	if g.shadow != nil && r.URL.Path == shadow.ReportPath {
		g.shadow.ServeReport(w, r)
		return
	}
	r2, done, ok := g.tracker.Admit(r)
	if !ok {
		drain.Reject(w, r)
		return
	}
	// Deferred: ReverseProxy aborts a broken stream by panicking.
	defer done()
	if g.shadow != nil {
		// Only the shadow tags a request; Node trusts the id on any request
		// the gateway relays.
		r2.Header.Del(shadow.IDHeader)
	}
	if g.shadow != nil && route.Match(r2.Method, r2.RequestURI) {
		peer, _ := proxy.PeerOf(r2.RemoteAddr, g.listenIPv6)
		var finish func()
		r2, finish = g.shadow.Observe(r2, peer)
		defer finish()
	}
	g.proxy.ServeHTTP(w, r2)
}

func (g *Gateway) appUp() bool {
	g.healthMu.Lock()
	defer g.healthMu.Unlock()
	if time.Since(g.healthAt) < time.Second {
		return g.healthAppUp
	}
	conn, err := net.DialTimeout("tcp", g.appAddr, 500*time.Millisecond)
	if err == nil {
		_ = conn.Close()
	}
	g.healthAt, g.healthAppUp = time.Now(), err == nil
	return g.healthAppUp
}

// health: 200 while serving, 503 while draining or when the app server
// doesn't accept connections. A client on this machine also gets counters.
func (g *Gateway) health(w http.ResponseWriter, r *http.Request) {
	body := map[string]any{"status": "ok", "mode": string(g.cfg.Mode)}
	code := http.StatusOK
	appUp := g.appUp()
	body["app"] = map[bool]string{true: "up", false: "down"}[appUp]
	switch {
	case g.tracker.Draining():
		body["status"], code = "draining", http.StatusServiceUnavailable
	case !appUp:
		body["status"], code = "app_down", http.StatusServiceUnavailable
	}
	peer, _ := proxy.PeerOf(r.RemoteAddr, g.listenIPv6)
	local := g.rule.IsOnThisMachine(clientip.FromRequest(r), peer)
	if g.cfg.Mode == config.ModeNative {
		// Native routes off never fails the check: everything is proxied.
		ready, reason := g.nativeStatus()
		body["native"] = map[bool]string{true: "ready", false: "off"}[ready]
		// The reason can carry SQLite's error text: this machine's clients only.
		if !ready && local {
			body["nativeReason"] = reason
		}
	}
	if local && g.shadow != nil {
		body["shadow"] = g.shadow.Snapshot()
	}
	if local {
		body["inflight"] = g.tracker.Inflight()
		body["uptimeSeconds"] = int(time.Since(g.startedAt).Seconds())
		body["version"] = g.version
		body["goroutines"] = runtime.NumGoroutine()
	}
	raw, _ := json.Marshal(body)
	if r.ContentLength != 0 {
		// A health check has no body. net/http would wait for one that is
		// declared but never sent, with no deadline, when the handler returns;
		// a deadline already past ends that wait and the connection.
		w.Header().Set("Connection", "close")
		_ = http.NewResponseController(w).SetReadDeadline(time.Now())
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Length", strconv.Itoa(len(raw)))
	w.WriteHeader(code)
	if r.Method != http.MethodHead {
		_, _ = w.Write(raw)
	}
}

func randomToken() string {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
}

func seconds(d time.Duration) int { return int((d + 500*time.Millisecond) / time.Second) }

// diagnosticSignals are the signals Node's --heapsnapshot-signal or
// --report-signal may be set to that the gateway would otherwise ignore.
var diagnosticSignals = map[string]os.Signal{"SIGUSR2": syscall.SIGUSR2, "SIGHUP": syscall.SIGHUP, "SIGQUIT": syscall.SIGQUIT}

// PassOnSignals are the signals the gateway hands to the app server instead
// of acting on them: SIGUSR1 (Node's inspector, unless --disable-sigusr1),
// and the signal a heap
// snapshot or diagnostic report handler is on (--heapsnapshot-signal, or
// --report-on-signal / --report-signal, default SIGUSR2) when it is SIGUSR2,
// SIGHUP or SIGQUIT. Any of those with no handler stays ignored: as PID 1,
// Node ignored them, and now its default action would kill it.
func PassOnSignals(nodeOptions string, command []string) []os.Signal {
	// Never nil: Run reads nil as "SIGUSR1 only".
	signals := []os.Signal{}
	args := strings.Fields(nodeOptions)
	if len(command) > 1 {
		args = append(args, nodeFlags(command[1:])...)
	}
	heapSignal, reportOn, reportSignal, inspectorOn := "", false, "SIGUSR2", true
	for i, a := range args {
		name, value, hasValue := strings.Cut(a, "=")
		name = strings.ReplaceAll(name, "_", "-")
		if !hasValue && nodeValueFlags[name] && i+1 < len(args) {
			value = args[i+1]
		}
		// Exact case: Node registers the handler on the name as written, and
		// a lowercase one installs none.
		value = strings.Trim(value, `"'`)
		switch name {
		case "--disable-sigusr1":
			// No inspector handler, so SIGUSR1's default action would kill it.
			inspectorOn = false
		case "--heapsnapshot-signal":
			heapSignal = value
		case "--report-on-signal":
			reportOn = true
		case "--no-report-on-signal":
			reportOn = false
		case "--report-signal":
			// Implies --report-on-signal, as in Node.
			reportSignal, reportOn = value, true
		}
	}
	if inspectorOn {
		signals = append(signals, syscall.SIGUSR1)
	}
	handlers := []string{heapSignal}
	if reportOn {
		handlers = append(handlers, reportSignal)
	}
	for _, name := range handlers {
		if sig, ok := diagnosticSignals[name]; ok && !slices.Contains(signals, sig) {
			signals = append(signals, sig)
		}
	}
	return signals
}

// passOn hands sig to the app server and reports true when it is one of
// pass; the shutdown signals are the gateway's own.
func passOn(sig os.Signal, pass []os.Signal, child *supervisor.Child) bool {
	for _, p := range pass {
		if sig == p {
			if child != nil {
				child.Signal(sig)
			}
			return true
		}
	}
	return false
}

// envValue is name's value in a KEY=value list, or "".
func envValue(env []string, name string) string {
	value := ""
	for _, kv := range env {
		if strings.HasPrefix(kv, name+"=") {
			value = kv[len(name)+1:]
		}
	}
	return value
}

// sigName is the name Node logs a signal by.
func sigName(sig os.Signal) string {
	switch sig {
	case syscall.SIGTERM:
		return "SIGTERM"
	case syscall.SIGINT:
		return "SIGINT"
	}
	return sig.String()
}

// Run serves until a shutdown signal (or the app server's exit) and returns
// the process exit code.
func Run(o Options) int {
	cfg := o.Config
	logger := o.Logger
	if logger == nil {
		logger = log.New(os.Stderr, "", 0)
	}
	if len(o.Command) > 0 && cfg.PeerToken == "" {
		cfg.PeerToken = randomToken()
	}
	// Without a token Node would take every request for its loopback peer,
	// so every remote client sending Host: localhost would be local.
	if len(cfg.PeerToken) < config.MinPeerTokenLength {
		logger.Printf("[Gateway] GATEWAY_PEER_TOKEN must be at least %d characters (it proves the client's address to the app server); not starting", config.MinPeerTokenLength)
		return 2
	}
	shadowURL := ""
	if cfg.Shadow {
		switch shadowURL = ShadowURL(cfg); {
		case shadowURL == "":
			logger.Printf("[Gateway] GATEWAY_SHADOW=1: HOSTNAME=%s isn't 0.0.0.0, ::, 127.0.0.1 or ::1, so the app server can't report its sends over loopback; shadow compare off", cfg.ListenHost)
			cfg.Shadow = false
		case len(o.Command) == 0:
			logger.Printf("[Gateway] GATEWAY_SHADOW=1: the gateway didn't start the app server, so it can't tell it where to report; shadow compare off")
			cfg.Shadow, shadowURL = false, ""
		}
	}
	switch {
	case cfg.Shadow:
		logger.Printf("[Gateway] GATEWAY_MODE=native with GATEWAY_SHADOW=1: the app server serves every request; the gateway compares the upstream request it would send for each /v1/messages with the app server's, and sends nothing")
	case cfg.Mode == config.ModeNative:
		logger.Printf("[Gateway] GATEWAY_MODE=native: this build serves no route natively yet; every request goes to the app server")
	}
	// How long the app server may take to stop: its drain, then its listeners.
	childDeadline := cfg.DrainTimeout + ListenerWait + time.Second

	var child *supervisor.Child
	if len(o.Command) > 0 {
		env := supervisor.Env(o.Env, map[string]string{
			"PORT":               strconv.Itoa(cfg.AppPort),
			"HOSTNAME":           "127.0.0.1",
			"KEEP_ALIVE_TIMEOUT": strconv.FormatInt(config.AppKeepAliveTimeout.Milliseconds(), 10),
			"GATEWAY_PEER_TOKEN": cfg.PeerToken,
			// The mode the gateway settled on, so Node doesn't parse the raw
			// value its own way (JS and Go trim and lowercase some Unicode
			// differently) and end up ignoring the handoff.
			"GATEWAY_MODE": string(cfg.Mode),
			// Shadow mode only as the gateway settled it, so a GATEWAY_SHADOW in
			// the environment alone never makes Node report.
			"GATEWAY_SHADOW":     map[bool]string{true: "1", false: ""}[cfg.Shadow],
			"GATEWAY_SHADOW_URL": shadowURL,
		})
		var err error
		child, err = supervisor.Start(o.Command, env)
		if err != nil {
			logger.Printf("[Gateway] could not start the app server (%v): %v", o.Command, err)
			return 1
		}
		logger.Printf("[Gateway] started the app server (pid %d) on 127.0.0.1:%d", child.Pid(), cfg.AppPort)
	}

	g := New(cfg, logger, o.Version)
	g.pass = o.PassOn
	if g.pass == nil {
		g.pass = []os.Signal{syscall.SIGUSR1}
	}

	// Listen only once the app server accepts, so a client during boot gets
	// a refused connection, as it does today, instead of a 502.
	if child != nil {
		if code, stop := waitForApp(g.appAddr, child, o.Signals, g.pass, logger, childDeadline); stop {
			return code
		}
	}

	// The schema guard tells a database Node hasn't migrated yet apart.
	if cfg.Mode == config.ModeNative {
		nativeCtx, stopNative := context.WithCancel(context.Background())
		// Deferred in this order so the watcher stops before the database closes.
		defer g.closeNative()
		defer stopNative()
		// In the background: a busy file can hold the first check for seconds,
		// and the relay doesn't wait on it. A database that opens after
		// shutdown began is closed again (nativeClosed).
		go g.openNative(nativeCtx, o.Env)
	}

	ln := o.Listener
	if ln == nil {
		var err error
		ln, err = net.Listen(listenNetwork(cfg.ListenHost), net.JoinHostPort(cfg.ListenHost, strconv.Itoa(cfg.ListenPort)))
		if err != nil {
			logger.Printf("[Gateway] listen: %v", err)
			stopChild(child, syscall.SIGTERM, childDeadline, logger)
			return 1
		}
	}
	srv := &http.Server{
		Handler:           g,
		ReadHeaderTimeout: cfg.HeadersTimeout,
		IdleTimeout:       cfg.IdleTimeout,
		MaxHeaderBytes:    maxHeaderBytes(envValue(o.Env, "NODE_OPTIONS"), o.Command),
		// OPTIONS * goes to Node as it did without the gateway, instead of
		// net/http's own empty 200.
		DisableGeneralOptionsHandler: true,
		ErrorLog:                     log.New(logger.Writer(), "[Gateway] http: ", 0),
	}
	serveErr := make(chan error, 1)
	go func() { serveErr <- srv.Serve(ln) }()
	logger.Printf("[Gateway] %s mode: listening on %s, relaying to the app server on %s", cfg.Mode, ln.Addr(), g.appAddr)
	if o.OnListening != nil {
		o.OnListening(ln.Addr().String())
	}

	var childDone <-chan struct{}
	if child != nil {
		childDone = child.Done()
	}
	for {
		select {
		case <-childDone:
			code := child.ExitCode()
			// Exit as the app server did, so the container's restart policy
			// sees the same code it sees today.
			logger.Printf("[Gateway] the app server exited with code %d; stopping", code)
			_ = srv.Close()
			return code
		case err := <-serveErr:
			if errors.Is(err, http.ErrServerClosed) {
				continue
			}
			logger.Printf("[Gateway] serve: %v", err)
			stopChild(child, syscall.SIGTERM, childDeadline, logger)
			return 1
		case sig := <-o.Signals:
			if passOn(sig, g.pass, child) {
				continue
			}
			return g.shutdown(sig, srv, child, o.Signals, childDeadline)
		}
	}
}

// waitForApp blocks until the app server accepts a connection. stop is true
// when Run should return code instead (the child exited, or a signal came).
func waitForApp(addr string, child *supervisor.Child, signals <-chan os.Signal, pass []os.Signal, logger *log.Logger, childDeadline time.Duration) (code int, stop bool) {
	tick := time.NewTicker(100 * time.Millisecond)
	defer tick.Stop()
	for {
		conn, err := net.DialTimeout("tcp", addr, time.Second)
		if err == nil {
			_ = conn.Close()
			return 0, false
		}
		select {
		case <-child.Done():
			logger.Printf("[Gateway] the app server exited with code %d before it listened", child.ExitCode())
			return child.ExitCode(), true
		case sig := <-signals:
			if passOn(sig, pass, child) {
				continue
			}
			logger.Printf("[Gateway] %s before the app server listened: stopping it", sigName(sig))
			child.Signal(sig)
			return waitChild(child, childDeadline, logger), true
		case <-tick.C:
		}
	}
}

// waitChild waits up to d for the child to exit, then kills it.
func waitChild(child *supervisor.Child, d time.Duration, logger *log.Logger) int {
	if child == nil {
		return 0
	}
	select {
	case <-child.Done():
		return child.ExitCode()
	case <-time.After(d):
		logger.Printf("[Gateway] the app server did not exit within %ds; killing it", seconds(d))
		child.Kill()
		<-child.Done()
		return 1
	}
}

func stopChild(child *supervisor.Child, sig os.Signal, d time.Duration, logger *log.Logger) {
	if child == nil {
		return
	}
	child.Signal(sig)
	waitChild(child, d, logger)
}

// shutdown is server-drain.js's drain, with the app server draining alongside:
// the first signal stops new connections (anything still arriving on an open
// one gets a 503), closes the never-ending dashboard streams, goes on to the
// app server, and waits until both the gateway's model requests and the app
// server are done. A repeat within DuplicateSignalWindow is ignored; a later
// one exits at once.
func (g *Gateway) shutdown(sig os.Signal, srv *http.Server, child *supervisor.Child, signals <-chan os.Signal, childDeadline time.Duration) int {
	logger := g.logger
	timeout := g.cfg.DrainTimeout
	if timeout <= 0 {
		logger.Printf("[Gateway] %s: the drain is off (SHUTDOWN_DRAIN_TIMEOUT_MS=0), stopping now", sigName(sig))
		g.tracker.Begin()
		if child != nil {
			child.Signal(sig)
		}
		_ = srv.Close()
		return waitChild(child, ListenerWait+time.Second, logger)
	}

	logger.Printf("[Gateway] %s: draining %d in-flight request(s), up to %ds; new connections are refused meanwhile (send the signal again to exit now)",
		sigName(sig), g.tracker.Inflight(), seconds(timeout))
	startedAt := time.Now()
	g.tracker.Begin()
	shutdownCtx, cancelShutdown := context.WithCancel(context.Background())
	defer cancelShutdown()
	// Closes the listener now and each connection once it goes idle.
	go func() { _ = srv.Shutdown(shutdownCtx) }()
	if child != nil {
		forward := time.AfterFunc(SignalSettle, func() { child.Signal(sig) })
		defer forward.Stop()
	}

	idle := make(chan struct{})
	go func() {
		if g.tracker.WaitIdle(shutdownCtx) == nil {
			close(idle)
		}
	}()
	var childDone <-chan struct{}
	childExited := child == nil
	if child != nil {
		childDone = child.Done()
	}
	// The app server's own deadline comes first, then its listeners get theirs.
	limit := timeout
	if child != nil {
		limit = childDeadline
	}
	deadline := time.NewTimer(limit)
	defer deadline.Stop()
	// No model request is admitted after Begin, so once idle stays idle.
	gatewayIdle := false
	var flush <-chan time.Time

	for {
		if childExited && gatewayIdle && flush == nil {
			flush = time.After(ExitFlush)
		}
		select {
		case again := <-signals:
			if passOn(again, g.pass, child) {
				continue
			}
			// Node's window opens when it gets the signal, SignalSettle later.
			if time.Since(startedAt) < DuplicateSignalWindow+SignalSettle {
				logger.Printf("[Gateway] %s right after the first signal: already draining, ignored", sigName(again))
				continue
			}
			logger.Printf("[Gateway] second %s: exiting now with %d request(s) still open", sigName(again), g.tracker.Inflight())
			if child != nil {
				child.Signal(again)
			}
			_ = srv.Close()
			waitChild(child, ListenerWait, logger)
			return 1
		case <-childDone:
			childExited, childDone = true, nil
			logger.Printf("[Gateway] the app server exited with code %d", child.ExitCode())
		case <-idle:
			gatewayIdle, idle = true, nil
		case <-flush:
			logger.Printf("[Gateway] drained in %ds, exiting", seconds(time.Since(startedAt)))
			_ = srv.Close()
			if child != nil {
				return child.ExitCode()
			}
			return 0
		case <-deadline.C:
			logger.Printf("[Gateway] drain timed out after %ds with %d request(s) still open, exiting", seconds(time.Since(startedAt)), g.tracker.Inflight())
			_ = srv.Close()
			if child != nil {
				child.Kill()
				<-child.Done()
			}
			return 1
		}
	}
}
