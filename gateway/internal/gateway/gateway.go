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
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/some-du6e/10router/gateway/internal/clientip"
	"github.com/some-du6e/10router/gateway/internal/config"
	"github.com/some-du6e/10router/gateway/internal/drain"
	"github.com/some-du6e/10router/gateway/internal/proxy"
	"github.com/some-du6e/10router/gateway/internal/supervisor"
)

// HealthPath is the gateway's own health endpoint. It never reaches the app.
const HealthPath = "/_gateway/health"

// Timings from server-drain.js.
const (
	// DuplicateSignalWindow: a repeat of the signal this soon is the same stop
	// arriving twice (a process-group kill reaches both processes).
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
}

// maxHeaderBytes caps a client's headers at about Node's --max-http-header-size
// (16 KiB unless NODE_OPTIONS sets it): net/http allows MaxHeaderBytes plus
// 4096 bytes of slack. custom-server.js gives its server 4 KiB more than that
// behind the gateway, room for the peer headers, so the gateway is the one
// that answers 431.
func maxHeaderBytes(nodeOptions string) int {
	size := nodeHeaderSize(nodeOptions)
	if size <= 8<<10 {
		return 4 << 10
	}
	return size - 4<<10
}

// nodeHeaderSize is the --max-http-header-size in NODE_OPTIONS, or Node's
// default; the last one given wins, as in Node.
func nodeHeaderSize(nodeOptions string) int {
	size := 16 << 10
	fields := strings.Fields(nodeOptions)
	for i, f := range fields {
		value, ok := strings.CutPrefix(f, "--max-http-header-size=")
		if !ok && f == "--max-http-header-size" && i+1 < len(fields) {
			value, ok = fields[i+1], true
		}
		if n, err := strconv.Atoi(value); ok && err == nil && n > 0 {
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

	healthMu    sync.Mutex
	healthAt    time.Time
	healthAppUp bool
}

// New builds the handler for cfg.
func New(cfg config.Config, logger *log.Logger, version string) *Gateway {
	appAddr := net.JoinHostPort("127.0.0.1", strconv.Itoa(cfg.AppPort))
	listenIPv6 := false
	if a, err := netip.ParseAddr(cfg.ListenHost); err == nil && a.Is6() && !a.Is4In6() {
		listenIPv6 = true
	}
	return &Gateway{
		cfg:        cfg,
		logger:     logger,
		tracker:    drain.NewTracker(),
		rule:       clientip.NewRule(cfg.TrustProxy),
		listenIPv6: listenIPv6,
		appAddr:    appAddr,
		version:    version,
		startedAt:  time.Now(),
		proxy: proxy.New(proxy.Options{
			Upstream:       &url.URL{Scheme: "http", Host: appAddr},
			PeerToken:      cfg.PeerToken,
			RequestTimeout: cfg.RequestTimeout,
			ListenIPv6:     listenIPv6,
			Transport:      proxy.NewTransport(config.AppIdleConnTimeout),
			Logger:         logger,
		}),
	}
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
	r2, done, ok := g.tracker.Admit(r)
	if !ok {
		drain.Reject(w, r)
		return
	}
	// Deferred: ReverseProxy aborts a broken stream by panicking.
	defer done()
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
	if g.rule.IsOnThisMachine(clientip.FromRequest(r), peer) {
		body["inflight"] = g.tracker.Inflight()
		body["uptimeSeconds"] = int(time.Since(g.startedAt).Seconds())
		body["version"] = g.version
		body["goroutines"] = runtime.NumGoroutine()
	}
	raw, _ := json.Marshal(body)
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

// passOn hands SIGUSR1/SIGUSR2 to the app server (SIGUSR1 opens Node's
// inspector) and reports true; the shutdown signals are the gateway's own.
func passOn(sig os.Signal, child *supervisor.Child) bool {
	if sig != syscall.SIGUSR1 && sig != syscall.SIGUSR2 {
		return false
	}
	if child != nil {
		child.Signal(sig)
	}
	return true
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
	if cfg.Mode == config.ModeNative {
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

	// Listen only once the app server accepts, so a client during boot gets
	// a refused connection, as it does today, instead of a 502.
	if child != nil {
		if code, stop := waitForApp(g.appAddr, child, o.Signals, logger, childDeadline); stop {
			return code
		}
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
		MaxHeaderBytes:    maxHeaderBytes(envValue(o.Env, "NODE_OPTIONS")),
		ErrorLog:          log.New(logger.Writer(), "[Gateway] http: ", 0),
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
			if passOn(sig, child) {
				continue
			}
			return g.shutdown(sig, srv, child, o.Signals, childDeadline)
		}
	}
}

// waitForApp blocks until the app server accepts a connection. stop is true
// when Run should return code instead (the child exited, or a signal came).
func waitForApp(addr string, child *supervisor.Child, signals <-chan os.Signal, logger *log.Logger, childDeadline time.Duration) (code int, stop bool) {
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
			if passOn(sig, child) {
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
			if passOn(again, child) {
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
