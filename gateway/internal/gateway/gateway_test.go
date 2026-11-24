package gateway

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/some-du6e/10router/gateway/internal/config"
)

// lockedBuffer collects log lines from several goroutines.
type lockedBuffer struct {
	mu sync.Mutex
	b  strings.Builder
}

func (l *lockedBuffer) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.Write(p)
}

func (l *lockedBuffer) String() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.String()
}

func freePort(t *testing.T) int {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	return ln.Addr().(*net.TCPAddr).Port
}

func portOf(t *testing.T, rawURL string) int {
	t.Helper()
	_, port, _ := net.SplitHostPort(strings.TrimPrefix(rawURL, "http://"))
	n, err := strconv.Atoi(port)
	if err != nil {
		t.Fatal(err)
	}
	return n
}

func baseConfig(appPort int) config.Config {
	return config.Config{
		Mode:           config.ModeProxy,
		ListenHost:     "127.0.0.1",
		ListenPort:     0,
		AppPort:        appPort,
		DrainTimeout:   30 * time.Second,
		RequestTimeout: config.DefaultRequestTimeout,
		HeadersTimeout: config.DefaultHeadersTimeout,
		IdleTimeout:    config.DefaultKeepAliveTimeout,
		PeerToken:      strings.Repeat("t", config.MinPeerTokenLength),
	}
}

// running is a gateway started with Run in front of an app that is already up.
type running struct {
	url     string
	signals chan os.Signal
	exit    chan int
	logs    *lockedBuffer
}

func startUnsupervised(t *testing.T, cfg config.Config) *running {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	r := &running{url: "http://" + ln.Addr().String(), signals: make(chan os.Signal, 4), exit: make(chan int, 1), logs: &lockedBuffer{}}
	go func() {
		r.exit <- Run(Options{Config: cfg, Signals: r.signals, Logger: log.New(r.logs, "", 0), Listener: ln})
	}()
	return r
}

func (r *running) waitExit(t *testing.T, within time.Duration) int {
	t.Helper()
	select {
	case code := <-r.exit:
		return code
	case <-time.After(within):
		t.Fatalf("the gateway did not exit within %v; log:\n%s", within, r.logs.String())
		return -1
	}
}

// held is an app whose /v1/ requests stream one event, then wait for release.
func heldApp(t *testing.T) (*httptest.Server, chan struct{}, chan struct{}) {
	started := make(chan struct{}, 8)
	release := make(chan struct{})
	app := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, "event: message_start\ndata: {}\n\n")
		w.(http.Flusher).Flush()
		started <- struct{}{}
		select {
		case <-release:
		case <-r.Context().Done():
			return
		}
		fmt.Fprint(w, "event: message_stop\ndata: {}\n\n")
	}))
	t.Cleanup(app.Close)
	return app, started, release
}

func TestDrainWaitsForModelRequests(t *testing.T) {
	app, started, release := heldApp(t)
	g := startUnsupervised(t, baseConfig(portOf(t, app.URL)))

	res, err := http.Post(g.url+"/v1/messages", "application/json", strings.NewReader("{}"))
	if err != nil {
		t.Fatal(err)
	}
	<-started
	g.signals <- syscall.SIGTERM
	// The same stop arriving twice is not a second ask.
	g.signals <- syscall.SIGTERM

	// New connections are refused once the listener closes.
	deadline := time.Now().Add(3 * time.Second)
	for {
		conn, err := net.DialTimeout("tcp", strings.TrimPrefix(g.url, "http://"), 200*time.Millisecond)
		if err != nil {
			break
		}
		conn.Close()
		if time.Now().After(deadline) {
			t.Fatal("still accepting connections during the drain")
		}
		time.Sleep(20 * time.Millisecond)
	}
	select {
	case code := <-g.exit:
		t.Fatalf("exited with %d while a stream was in flight", code)
	case <-time.After(300 * time.Millisecond):
	}
	close(release)
	body, err := io.ReadAll(res.Body)
	res.Body.Close()
	if err != nil || !strings.Contains(string(body), "message_stop") {
		t.Fatalf("stream cut: %q %v", body, err)
	}
	if code := g.waitExit(t, 3*time.Second); code != 0 {
		t.Fatalf("exit code %d", code)
	}
	logs := g.logs.String()
	for _, want := range []string{"SIGTERM: draining 1 in-flight request(s)", "already draining, ignored", "drained in"} {
		if !strings.Contains(logs, want) {
			t.Errorf("log lacks %q:\n%s", want, logs)
		}
	}
}

func TestSecondSignalExitsNow(t *testing.T) {
	app, started, release := heldApp(t)
	defer close(release)
	g := startUnsupervised(t, baseConfig(portOf(t, app.URL)))
	res, err := http.Post(g.url+"/v1/messages", "application/json", strings.NewReader("{}"))
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	<-started
	g.signals <- syscall.SIGTERM
	time.Sleep(DuplicateSignalWindow + SignalSettle + 100*time.Millisecond)
	g.signals <- syscall.SIGINT
	if code := g.waitExit(t, 2*time.Second); code != 1 {
		t.Fatalf("exit code %d", code)
	}
	if !strings.Contains(g.logs.String(), "second SIGINT: exiting now with 1 request(s) still open") {
		t.Errorf("log:\n%s", g.logs.String())
	}
}

func TestDrainTimesOut(t *testing.T) {
	app, started, release := heldApp(t)
	defer close(release)
	cfg := baseConfig(portOf(t, app.URL))
	cfg.DrainTimeout = 200 * time.Millisecond
	g := startUnsupervised(t, cfg)
	res, err := http.Post(g.url+"/v1/messages", "application/json", strings.NewReader("{}"))
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	<-started
	g.signals <- syscall.SIGTERM
	if code := g.waitExit(t, 2*time.Second); code != 1 {
		t.Fatalf("exit code %d", code)
	}
	if !strings.Contains(g.logs.String(), "drain timed out") {
		t.Errorf("log:\n%s", g.logs.String())
	}
}

func TestDrainOffStopsAtOnce(t *testing.T) {
	app, started, release := heldApp(t)
	defer close(release)
	cfg := baseConfig(portOf(t, app.URL))
	cfg.DrainTimeout = 0
	g := startUnsupervised(t, cfg)
	res, err := http.Post(g.url+"/v1/messages", "application/json", strings.NewReader("{}"))
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	<-started
	g.signals <- syscall.SIGTERM
	if code := g.waitExit(t, time.Second); code != 0 {
		t.Fatalf("exit code %d", code)
	}
}

func TestDashboardStreamsCloseWhenTheDrainStarts(t *testing.T) {
	app, started, release := heldApp(t)
	g := startUnsupervised(t, baseConfig(portOf(t, app.URL)))
	stream, err := http.Get(g.url + "/api/usage/stream")
	if err != nil {
		t.Fatal(err)
	}
	defer stream.Body.Close()
	<-started
	// A model request keeps the drain open meanwhile.
	model, err := http.Post(g.url+"/v1/messages", "application/json", strings.NewReader("{}"))
	if err != nil {
		t.Fatal(err)
	}
	defer model.Body.Close()
	<-started
	g.signals <- syscall.SIGTERM
	ended := make(chan struct{})
	go func() {
		_, _ = io.Copy(io.Discard, stream.Body)
		close(ended)
	}()
	select {
	case <-ended:
	case <-time.After(2 * time.Second):
		t.Fatal("the dashboard stream stayed open during the drain")
	}
	select {
	case code := <-g.exit:
		t.Fatalf("exited with %d while a model request was in flight", code)
	default:
	}
	close(release)
	_, _ = io.Copy(io.Discard, model.Body)
	if code := g.waitExit(t, 3*time.Second); code != 0 {
		t.Fatalf("exit code %d", code)
	}
}

func TestRefusesAShortPeerToken(t *testing.T) {
	cfg := baseConfig(freePort(t))
	cfg.PeerToken = "short"
	logs := &lockedBuffer{}
	if code := Run(Options{Config: cfg, Logger: log.New(logs, "", 0)}); code != 2 {
		t.Fatalf("exit code %d", code)
	}
	cfg.PeerToken = ""
	if code := Run(Options{Config: cfg, Logger: log.New(logs, "", 0)}); code != 2 {
		t.Fatalf("no token, no command: exit code %d", code)
	}
	if !strings.Contains(logs.String(), "GATEWAY_PEER_TOKEN must be at least 32 characters") {
		t.Errorf("log:\n%s", logs.String())
	}
}

func TestHeaderCapFollowsNode(t *testing.T) {
	for opts, want := range map[string]int{
		"":                                 12 << 10,
		"--use-system-ca":                  12 << 10,
		"--max-http-header-size=32768":     28 << 10,
		"--max-http-header-size 65536 --x": 60 << 10,
		"--max-http-header-size=8192":      4 << 10,
		"--max-http-header-size=1 --max-http-header-size=20480": 16 << 10,
		"--max-http-header-size=abc":                            12 << 10,
		"--max_http_header_size=32768":                          28 << 10,
		`--max-http-header-size="32768"`:                        28 << 10,
	} {
		if got := maxHeaderBytes(opts, []string{"node", "custom-server.js"}); got != want {
			t.Errorf("maxHeaderBytes(%q) = %d, want %d", opts, got, want)
		}
	}
	// Node's own flags win over NODE_OPTIONS; the script's arguments don't count.
	if got := maxHeaderBytes("--max-http-header-size=32768", []string{"node", "--max-http-header-size=65536", "custom-server.js"}); got != 60<<10 {
		t.Errorf("command-line flag: %d", got)
	}
	if got := maxHeaderBytes("", []string{"node", "custom-server.js", "--max-http-header-size=65536"}); got != 12<<10 {
		t.Errorf("script argument taken for a node flag: %d", got)
	}
}

func TestOnlySIGUSR1GoesOnToNode(t *testing.T) {
	if !passOn(syscall.SIGUSR1, nil) {
		t.Error("SIGUSR1 is not passed on")
	}
	// SIGUSR2's default action would kill Node; the shutdown signals drain.
	for _, sig := range []os.Signal{syscall.SIGUSR2, syscall.SIGTERM, syscall.SIGINT} {
		if passOn(sig, nil) {
			t.Errorf("%v passed on", sig)
		}
	}
}

func TestListenNetwork(t *testing.T) {
	for host, want := range map[string]string{"0.0.0.0": "tcp4", "127.0.0.1": "tcp4", "::": "tcp", "localhost": "tcp", "": "tcp"} {
		if got := listenNetwork(host); got != want {
			t.Errorf("listenNetwork(%q) = %q, want %q", host, got, want)
		}
	}
}

func TestRequestsDuringTheDrainGet503(t *testing.T) {
	app, _, release := heldApp(t)
	defer close(release)
	g := New(baseConfig(portOf(t, app.URL)), log.New(io.Discard, "", 0), "test")
	g.tracker.Begin()
	w := httptest.NewRecorder()
	g.ServeHTTP(w, httptest.NewRequest("POST", "/v1/messages", strings.NewReader("{}")))
	if w.Code != 503 || w.Header().Get("Retry-After") != "5" || !strings.Contains(w.Body.String(), "server_draining") {
		t.Fatalf("got %d %v %s", w.Code, w.Header(), w.Body.String())
	}
}

func TestHealth(t *testing.T) {
	app := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("the health check reached the app")
	}))
	defer app.Close()
	g := New(baseConfig(portOf(t, app.URL)), log.New(io.Discard, "", 0), "test")

	check := func(remote string) (int, map[string]any) {
		r := httptest.NewRequest("GET", HealthPath, nil)
		r.RemoteAddr = remote
		r.Host = "localhost:20128"
		w := httptest.NewRecorder()
		g.ServeHTTP(w, r)
		var body map[string]any
		_ = json.Unmarshal(w.Body.Bytes(), &body)
		return w.Code, body
	}
	code, body := check("127.0.0.1:5000")
	if code != 200 || body["status"] != "ok" || body["app"] != "up" || body["version"] != "test" {
		t.Fatalf("local: %d %v", code, body)
	}
	code, body = check("203.0.113.7:5000")
	if code != 200 || body["status"] != "ok" || body["version"] != nil || body["inflight"] != nil {
		t.Fatalf("remote: %d %v", code, body)
	}
	g.tracker.Begin()
	if code, body = check("127.0.0.1:5000"); code != 503 || body["status"] != "draining" {
		t.Fatalf("draining: %d %v", code, body)
	}

	app.Close()
	down := New(baseConfig(portOf(t, app.URL)), log.New(io.Discard, "", 0), "test")
	r := httptest.NewRequest("GET", HealthPath, nil)
	w := httptest.NewRecorder()
	down.ServeHTTP(w, r)
	if w.Code != 503 || !strings.Contains(w.Body.String(), `"app_down"`) {
		t.Fatalf("app down: %d %s", w.Code, w.Body.String())
	}
}

// ── The supervised path: a real child process standing in for Node ────────

const childEnv = "GATEWAY_TEST_CHILD"

// TestHelperChild is the child process, not a test: a stand-in for
// custom-server.js that listens on PORT/HOSTNAME, reports what it was given,
// and drains on SIGTERM the way server-drain.js does.
func TestHelperChild(t *testing.T) {
	if os.Getenv(childEnv) != "1" {
		t.Skip("helper process")
	}
	if os.Getenv("GATEWAY_TEST_CHILD_EARLY_EXIT") != "" {
		// Dies at boot, before it listens.
		os.Exit(4)
	}
	exitCode, _ := strconv.Atoi(os.Getenv("GATEWAY_TEST_CHILD_EXIT"))
	signals := make(chan os.Signal, 2)
	signal.Notify(signals, syscall.SIGTERM, syscall.SIGINT)
	var wg sync.WaitGroup
	srv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		wg.Add(1)
		defer wg.Done()
		switch r.URL.Path {
		case "/env":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"port":      os.Getenv("PORT"),
				"hostname":  os.Getenv("HOSTNAME"),
				"keepAlive": os.Getenv("KEEP_ALIVE_TIMEOUT"),
				"peerOK":    r.Header.Get("X-9r-Gw-Token") != "" && r.Header.Get("X-9r-Gw-Token") == os.Getenv("GATEWAY_PEER_TOKEN"),
				"peerIP":    r.Header.Get("X-9r-Gw-Peer-Ip"),
			})
		case "/v1/slow":
			w.Header().Set("Content-Type", "text/event-stream")
			for i := 0; i < 10; i++ {
				fmt.Fprintf(w, "data: %d\n\n", i)
				w.(http.Flusher).Flush()
				time.Sleep(100 * time.Millisecond)
			}
			fmt.Fprint(w, "data: done\n\n")
		case "/crash":
			os.Exit(3)
		}
	})}
	ln, err := net.Listen("tcp", net.JoinHostPort(os.Getenv("HOSTNAME"), os.Getenv("PORT")))
	if err != nil {
		os.Exit(9)
	}
	go func() { _ = srv.Serve(ln) }()
	<-signals
	fmt.Fprintln(os.Stderr, "[child] draining")
	_ = srv.Shutdown(context.Background())
	wg.Wait()
	os.Exit(exitCode)
}

func startSupervised(t *testing.T, env ...string) (*running, config.Config) {
	t.Helper()
	cfg := baseConfig(freePort(t))
	cfg.ListenPort = freePort(t)
	// The gateway makes its own when it starts the app server.
	cfg.PeerToken = ""
	r := &running{signals: make(chan os.Signal, 4), exit: make(chan int, 1), logs: &lockedBuffer{}}
	listening := make(chan string, 1)
	go func() {
		r.exit <- Run(Options{
			Config:      cfg,
			Command:     []string{os.Args[0], "-test.run=^TestHelperChild$"},
			Env:         append(append(os.Environ(), childEnv+"=1", "PORT=1", "HOSTNAME=0.0.0.0"), env...),
			Signals:     r.signals,
			Logger:      log.New(r.logs, "", 0),
			OnListening: func(addr string) { listening <- addr },
		})
	}()
	select {
	case addr := <-listening:
		r.url = "http://" + addr
	case code := <-r.exit:
		t.Fatalf("exited with %d before listening:\n%s", code, r.logs.String())
	case <-time.After(20 * time.Second):
		t.Fatalf("never listened:\n%s", r.logs.String())
	}
	return r, cfg
}

func TestSupervisedChildGetsItsPortAndPeer(t *testing.T) {
	g, cfg := startSupervised(t)
	res, err := http.Get(g.url + "/env")
	if err != nil {
		t.Fatal(err)
	}
	var env map[string]any
	_ = json.NewDecoder(res.Body).Decode(&env)
	res.Body.Close()
	if env["port"] != strconv.Itoa(cfg.AppPort) || env["hostname"] != "127.0.0.1" || env["keepAlive"] != "30000" {
		t.Errorf("child env %v", env)
	}
	if env["peerOK"] != true || env["peerIP"] != "127.0.0.1" {
		t.Errorf("peer handoff %v", env)
	}

	// The drain covers both processes: the stream finishes, then both exit.
	res, err = http.Get(g.url + "/v1/slow")
	if err != nil {
		t.Fatal(err)
	}
	reader := bufio.NewReader(res.Body)
	if _, err := reader.ReadString('\n'); err != nil {
		t.Fatal(err)
	}
	g.signals <- syscall.SIGTERM
	rest, err := io.ReadAll(reader)
	res.Body.Close()
	if err != nil || !strings.Contains(string(rest), "data: done") {
		t.Fatalf("stream cut by the drain: %q %v", rest, err)
	}
	if code := g.waitExit(t, 10*time.Second); code != 0 {
		t.Fatalf("exit code %d; log:\n%s", code, g.logs.String())
	}
	if !strings.Contains(g.logs.String(), "the app server exited with code 0") {
		t.Errorf("log:\n%s", g.logs.String())
	}
}

func TestSupervisedExitCodeIsTheAppServers(t *testing.T) {
	g, _ := startSupervised(t, "GATEWAY_TEST_CHILD_EXIT=5")
	g.signals <- syscall.SIGTERM
	if code := g.waitExit(t, 10*time.Second); code != 5 {
		t.Fatalf("exit code %d, want the child's 5; log:\n%s", code, g.logs.String())
	}
}

func TestSupervisedChildDyingAtBoot(t *testing.T) {
	cfg := baseConfig(freePort(t))
	cfg.ListenPort = freePort(t)
	cfg.PeerToken = ""
	logs := &lockedBuffer{}
	code := Run(Options{
		Config:  cfg,
		Command: []string{os.Args[0], "-test.run=^TestHelperChild$"},
		Env:     append(os.Environ(), childEnv+"=1", "GATEWAY_TEST_CHILD_EARLY_EXIT=1"),
		Signals: make(chan os.Signal),
		Logger:  log.New(logs, "", 0),
	})
	if code != 4 || !strings.Contains(logs.String(), "before it listened") {
		t.Fatalf("exit code %d; log:\n%s", code, logs.String())
	}
	// It never listened on the public port.
	if conn, err := net.Dial("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(cfg.ListenPort))); err == nil {
		conn.Close()
		t.Fatal("the public port is open")
	}
}

func TestSupervisedChildCrashEndsTheGateway(t *testing.T) {
	g, _ := startSupervised(t)
	res, err := http.Get(g.url + "/crash")
	if err == nil {
		res.Body.Close()
	}
	if code := g.waitExit(t, 10*time.Second); code != 3 {
		t.Fatalf("exit code %d, want the child's 3; log:\n%s", code, g.logs.String())
	}
}
