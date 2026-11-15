import { afterEach, describe, expect, it, vi } from "vitest";
import http from "node:http";
import net from "node:net";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { holdShutdown } from "../../open-sse/utils/shutdownHold.js";
import { createStreamController } from "../../open-sse/utils/streamHandler.js";

const require = createRequire(import.meta.url);
const {
  BACKGROUND_WORK_KEY,
  DEFAULT_DRAIN_TIMEOUT_MS,
  DUPLICATE_SIGNAL_WINDOW_MS,
  LISTENER_WAIT_MS,
  MAX_DRAIN_TIMEOUT_MS,
  createDrain,
  gateShutdownSignals,
  installShutdownDrain,
  isLongLived,
  isModelTraffic,
  parseDrainTimeout,
} = require("../../server-drain.js");

const servers = [];
const agents = [];

afterEach(async () => {
  delete globalThis[BACKGROUND_WORK_KEY];
  for (const agent of agents.splice(0)) agent.destroy();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(() => resolve()));
  }
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const work = () => globalThis[BACKGROUND_WORK_KEY]?.count ?? 0;

const newDrain = (options = {}) => {
  const exit = vi.fn();
  const logs = [];
  const drain = createDrain({ timeoutMs: 10_000, flushMs: 10, exit, log: (line) => logs.push(line), ...options });
  return { drain, exit, logs };
};

// GET <any>/slow?id=x (or /stream) sends one SSE event, then waits for
// release(x) before the last one, like a model stream. A POST reads its whole
// body first. Anything else answers "ok" at once.
async function startServer(drain, { requestTimeout } = {}) {
  const gates = new Map();
  const gate = (id) => {
    if (!gates.has(id)) {
      let open;
      const promise = new Promise((resolve) => { open = resolve; });
      gates.set(id, { promise, open });
    }
    return gates.get(id);
  };
  const server = http.createServer(async (req, res) => {
    if (!drain.track(req, res)) return;
    const url = new URL(req.url, "http://x");
    if (req.method === "POST") {
      try {
        for await (const chunk of req) void chunk;
      } catch {
        return; // cut mid-body
      }
      res.end("posted");
      return;
    }
    if (url.pathname.endsWith("/slow") || url.pathname.endsWith("/stream")) {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write("data: first\n\n");
      await gate(url.searchParams.get("id") || "default").promise;
      res.end("data: last\n\n");
      return;
    }
    res.end("ok");
  });
  if (requestTimeout !== undefined) server.requestTimeout = requestTimeout;
  drain.addServer(server);
  servers.push(server);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, port: server.address().port, release: (id = "default") => gate(id).open() };
}

// Starts a GET; `started` resolves on the first bytes, `body` with the rest
// (`complete: false` when the connection is cut).
function startStream(port, path, { agent = false } = {}) {
  let onStarted;
  const started = new Promise((resolve) => { onStarted = resolve; });
  let request;
  const body = new Promise((resolve) => {
    let text = "";
    request = http.get({ host: "127.0.0.1", port, path, agent }, (res) => {
      res.setEncoding("utf8");
      res.on("data", (chunk) => { text += chunk; onStarted(); });
      res.on("end", () => resolve({ text, complete: true }));
      res.on("error", () => resolve({ text, complete: false }));
      res.on("aborted", () => resolve({ text, complete: false }));
    });
    request.on("error", () => resolve({ text, complete: false }));
  });
  return { started, body, abort: () => request.destroy(), request };
}

function connect(port) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

function get(port, path) {
  return new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port, path, agent: false }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { text += chunk; });
      res.on("end", () => resolve(text));
    }).on("error", reject);
  });
}

// A raw POST whose body arrives in pieces; returns the socket and what it read.
async function startUpload(port, length) {
  const socket = await connect(port);
  let raw = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => { raw += chunk; });
  socket.on("error", () => {});
  const closed = new Promise((resolve) => socket.on("close", resolve));
  socket.write(`POST /v1/chat/completions HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: ${length}\r\nConnection: close\r\n\r\n`);
  return { socket, closed, read: () => raw };
}

describe("server drain on shutdown", () => {
  it("lets an in-flight stream finish, refuses new connections, then exits 0", async () => {
    const { drain, exit, logs } = newDrain();
    const { port, release } = await startServer(drain);

    const slow = startStream(port, "/v1/slow");
    await slow.started;
    drain.start("SIGTERM");

    expect(drain.draining).toBe(true);
    expect(logs[0]).toContain("draining 1 in-flight request(s)");
    expect(logs[0]).toContain("new connections are refused");

    await expect(connect(port)).rejects.toMatchObject({ code: "ECONNREFUSED" });
    expect(exit).not.toHaveBeenCalled();

    release();
    expect(await slow.body).toEqual({ text: "data: first\n\ndata: last\n\n", complete: true });
    await vi.waitFor(() => expect(exit).toHaveBeenCalledTimes(1));
    expect(exit).toHaveBeenCalledWith(0, { reason: "drained", open: 0, signal: "SIGTERM" });
    expect(logs.at(-1)).toMatch(/drained in \d+s, exiting/);
  });

  it("waits for every stream: a finished request and one of two streams are not enough", async () => {
    const { drain, exit } = newDrain();
    const { port, release } = await startServer(drain);

    expect(await get(port, "/v1/models")).toBe("ok");
    const a = startStream(port, "/v1/slow?id=a");
    const b = startStream(port, "/v1/slow?id=b");
    await Promise.all([a.started, b.started]);
    drain.start("SIGTERM");
    expect(drain.inflight).toBe(2);

    release("a");
    await a.body;
    await sleep(60);
    expect(drain.inflight).toBe(1);
    expect(exit).not.toHaveBeenCalled();

    release("b");
    await b.body;
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0, { reason: "drained", open: 0, signal: "SIGTERM" }));
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it("exits right away when nothing is in flight", async () => {
    const { drain, exit } = newDrain();
    await startServer(drain);
    drain.start("SIGTERM");
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0, { reason: "drained", open: 0, signal: "SIGTERM" }), { timeout: 500 });
  });

  // server.close() does this on Node 19+; the drain relies on it.
  it("closes a keep-alive socket that is idle when the drain starts", async () => {
    const { drain } = newDrain();
    const { port, release } = await startServer(drain);
    const slow = startStream(port, "/v1/slow");
    await slow.started;

    const socket = await connect(port);
    let raw = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => { raw += chunk; });
    const closed = new Promise((resolve) => socket.on("close", resolve));
    socket.write(`GET /v1/models HTTP/1.1\r\nHost: x\r\nConnection: keep-alive\r\n\r\n`);
    await vi.waitFor(() => expect(raw).toContain("ok"));

    drain.start("SIGTERM");
    await closed;
    release();
    await slow.body;
  });

  it("closes a keep-alive socket that goes idle partway through the drain", async () => {
    const { drain } = newDrain();
    const { port, release } = await startServer(drain);
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    agents.push(agent);

    const other = startStream(port, "/v1/slow?id=other");
    const kept = startStream(port, "/v1/slow?id=kept", { agent });
    await Promise.all([other.started, kept.started]);
    const keptSocket = await new Promise((resolve) => {
      if (kept.request.socket) resolve(kept.request.socket);
      else kept.request.once("socket", resolve);
    });
    const closed = new Promise((resolve) => keptSocket.once("close", resolve));

    drain.start("SIGTERM");
    release("kept");
    expect((await kept.body).complete).toBe(true);
    // Back in the agent's pool, idle; the drain must close it, not keepAliveTimeout (5 s).
    await Promise.race([closed, sleep(1000).then(() => { throw new Error("idle socket left open"); })]);
    release("other");
    await other.body;
  });

  it("answers a request on an open keep-alive socket with 503 + Retry-After + Connection: close", async () => {
    const { drain, exit } = newDrain();
    const { server, port, release } = await startServer(drain);
    const sawNew = new Promise((resolve) => server.on("request", (req) => { if (req.url === "/v1/new") resolve(); }));

    const socket = await connect(port);
    let raw = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => { raw += chunk; });
    const closed = new Promise((resolve) => socket.on("close", resolve));
    socket.write(`GET /v1/slow HTTP/1.1\r\nHost: x\r\nConnection: keep-alive\r\n\r\n`);
    await vi.waitFor(() => expect(raw).toContain("data: first"));

    drain.start("SIGTERM");
    // Same socket, after the drain started: must not reach the handler.
    socket.write(`GET /v1/new HTTP/1.1\r\nHost: x\r\nConnection: keep-alive\r\n\r\n`);
    await sawNew;
    release();
    await closed;

    const second = raw.slice(raw.indexOf("HTTP/1.1", 1));
    expect(raw).toContain("data: last");
    expect(second).toMatch(/^HTTP\/1\.1 503/);
    expect(second).toMatch(/\r\nRetry-After: 5\r\n/i);
    expect(second).toMatch(/\r\nConnection: close\r\n/i);
    expect(second).toContain("server_draining");
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0, { reason: "drained", open: 0, signal: "SIGTERM" }));
  });

  it("stops counting a stream whose client hangs up", async () => {
    const { drain, exit } = newDrain();
    const { port, release } = await startServer(drain);
    const slow = startStream(port, "/v1/slow");
    await slow.started;
    drain.start("SIGTERM");
    expect(drain.inflight).toBe(1);

    slow.abort();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0, { reason: "drained", open: 0, signal: "SIGTERM" }));
    release();
  });

  it("does not wait for a dashboard stream that never ends, and closes it; a /v1 stream does hold the drain", async () => {
    const { drain, exit } = newDrain();
    const { port, release } = await startServer(drain);
    const usage = startStream(port, "/api/usage/stream?id=never");
    const model = startStream(port, "/v1/slow");
    await Promise.all([usage.started, model.started]);

    drain.start("SIGTERM");
    expect(drain.inflight).toBe(1);
    expect(await usage.body).toEqual({ text: "data: first\n\n", complete: false });
    await sleep(60);
    expect(exit).not.toHaveBeenCalled();

    release();
    expect((await model.body).complete).toBe(true);
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0, { reason: "drained", open: 0, signal: "SIGTERM" }));
  });

  it("cuts a trickled body at requestTimeout counted from the request's start, not the drain's", async () => {
    const { drain, exit, logs } = newDrain();
    const { port } = await startServer(drain, { requestTimeout: 1000 });

    const startedAt = Date.now();
    const upload = await startUpload(port, 100_000);
    const trickle = setInterval(() => upload.socket.write(" "), 20);
    await sleep(800);
    drain.start("SIGTERM");
    await upload.closed;
    clearInterval(trickle);
    // From the drain's start it would be ~1800 ms.
    expect(Date.now() - startedAt).toBeLessThan(1500);
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0, { reason: "drained", open: 0, signal: "SIGTERM" }));
    expect(logs.join("\n")).toContain("still sending its body past requestTimeout");
  });

  it("lets a slow but steady upload that started before the drain finish", async () => {
    const { drain, exit } = newDrain();
    const { port } = await startServer(drain, { requestTimeout: 2000 });

    const upload = await startUpload(port, 40);
    let sent = 0;
    const steady = setInterval(() => {
      if (sent < 40) { upload.socket.write("x"); sent++; }
    }, 20);
    await sleep(100);
    drain.start("SIGTERM");
    await upload.closed;
    clearInterval(steady);
    expect(upload.read()).toMatch(/^HTTP\/1\.1 200[\s\S]*posted$/);
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0, { reason: "drained", open: 0, signal: "SIGTERM" }));
  });

  it("leaves a stream whose body was complete alone, however long it runs past requestTimeout", async () => {
    const { drain, exit } = newDrain();
    const { port, release } = await startServer(drain, { requestTimeout: 100 });
    const slow = startStream(port, "/v1/slow");
    await slow.started;
    drain.start("SIGTERM");
    await sleep(300);
    expect(drain.inflight).toBe(1);
    release();
    expect((await slow.body).complete).toBe(true);
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0, { reason: "drained", open: 0, signal: "SIGTERM" }));
  });

  it("exits on timeout with the count still open", async () => {
    const { drain, exit, logs } = newDrain({ timeoutMs: 150 });
    const { port, release } = await startServer(drain);

    const slow = startStream(port, "/v1/slow");
    await slow.started;
    drain.start("SIGTERM");

    await vi.waitFor(() => expect(exit).toHaveBeenCalledTimes(1), { timeout: 2000 });
    expect(exit).toHaveBeenCalledWith(1, { reason: "timeout", open: 1, signal: "SIGTERM" });
    expect(logs.at(-1)).toContain("1 request(s) still open");
    release();
    await slow.body;
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it("ignores a repeat signal inside the default window, saying so, and exits on one after it", async () => {
    expect(DUPLICATE_SIGNAL_WINDOW_MS).toBe(1500);
    const { drain, exit, logs } = newDrain({ duplicateWindowMs: undefined });
    const release = drain.hold();

    drain.start("SIGINT");
    drain.start("SIGTERM");
    expect(exit).not.toHaveBeenCalled();
    expect(logs.at(-1)).toBe("[Shutdown] SIGTERM right after the first signal: already draining, ignored");

    await sleep(1000);
    drain.start("SIGINT");
    expect(exit).not.toHaveBeenCalled();
    await sleep(800);
    drain.start("SIGINT");
    expect(exit).toHaveBeenCalledWith(1, { reason: "signal", open: 1, signal: "SIGINT" });
    release();
  });

  it("leaves a trickled body to the drain's own deadline when requestTimeout is 0, as Node would", () => {
    vi.useFakeTimers();
    try {
      const { drain, exit, logs } = newDrain({ timeoutMs: 400_000 });
      const socket = { server: { requestTimeout: 0 }, destroy: vi.fn() };
      const req = { url: "/v1/chat/completions", complete: false, socket };
      const res = new EventEmitter();
      expect(drain.track(req, res)).toBe(true);
      drain.start("SIGTERM");

      // Past the 300 s a server without the setting would get.
      vi.advanceTimersByTime(350_000);
      expect(socket.destroy).not.toHaveBeenCalled();
      expect(logs.join("\n")).not.toContain("still sending its body");
      expect(drain.inflight).toBe(1);

      vi.advanceTimersByTime(60_000);
      expect(exit).toHaveBeenCalledWith(1, { reason: "timeout", open: 1, signal: "SIGTERM" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("cuts a request admitted during the drain whose body trickles past requestTimeout", async () => {
    const { drain, exit, logs } = newDrain({ timeoutMs: 3000 });
    const { server, port } = await startServer(drain, { requestTimeout: 500 });
    server.removeAllListeners("request");
    server.on("request", async (req, res) => {
      if (!drain.track(req, res, { admit: req.headers["x-admit"] === "1" })) return;
      if (req.url === "/v1/hold") return; // never answered
      try {
        for await (const chunk of req) void chunk;
      } catch {
        return;
      }
      res.end("posted");
    });

    const socket = await connect(port);
    socket.on("error", () => {});
    const closed = new Promise((resolve) => socket.on("close", resolve));
    socket.write(`GET /v1/hold HTTP/1.1\r\nHost: x\r\n\r\n`);
    await vi.waitFor(() => expect(drain.inflight).toBe(1));
    drain.start("SIGTERM");
    socket.write(`POST /backend-api/codex/responses HTTP/1.1\r\nHost: x\r\nX-Admit: 1\r\nContent-Length: 1000\r\n\r\n{"in`);
    await vi.waitFor(() => expect(drain.inflight).toBe(2));
    const trickle = setInterval(() => socket.write(" "), 20);
    await closed;
    clearInterval(trickle);
    // Cut by the body guard (500 ms), not left to the drain's 3 s timeout.
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0, { reason: "drained", open: 0, signal: "SIGTERM" }), { timeout: 2000 });
    expect(logs.join("\n")).toContain("still sending its body past requestTimeout");
  });

  it("admits a request let through during the drain, and still counts it", async () => {
    const { drain, exit } = newDrain();
    const { server, port } = await startServer(drain);
    // Re-route requests so the test decides who is admitted.
    server.removeAllListeners("request");
    let gateOpen;
    const gate = new Promise((resolve) => { gateOpen = resolve; });
    server.on("request", async (req, res) => {
      if (!drain.track(req, res, { admit: req.headers["x-admit"] === "1" })) return;
      if (req.url === "/v1/hold") await gate;
      res.end("served");
    });

    const socket = await connect(port);
    let raw = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => { raw += chunk; });
    socket.write(`GET /v1/hold HTTP/1.1\r\nHost: x\r\n\r\n`);
    await vi.waitFor(() => expect(drain.inflight).toBe(1));
    drain.start("SIGTERM");
    socket.write(`GET /backend-api/codex/responses HTTP/1.1\r\nHost: x\r\nX-Admit: 1\r\n\r\n`);
    await vi.waitFor(() => expect(drain.inflight).toBe(2));
    gateOpen();
    await vi.waitFor(() => expect(raw.match(/served/g)).toHaveLength(2));
    expect(raw).not.toContain(" 503 ");
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0, { reason: "drained", open: 0, signal: "SIGTERM" }));
    socket.destroy();
  });

  it("waits out the flush grace before exiting, and rechecks the count when it ends", async () => {
    const { drain, exit } = newDrain({ flushMs: 150 });
    const first = drain.hold();
    drain.start("SIGTERM");
    first();
    await sleep(50);
    expect(exit).not.toHaveBeenCalled();
    // Work that starts inside the grace (a usage read after a hang-up, say).
    const late = drain.hold();
    await sleep(200);
    expect(exit).not.toHaveBeenCalled();
    late();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0, { reason: "drained", open: 0, signal: "SIGTERM" }));
  });

  it("waits for work registered with holdShutdown; a second release changes nothing", async () => {
    const { drain, exit } = newDrain();
    const release = holdShutdown();
    const other = holdShutdown();
    drain.start("SIGTERM");
    await sleep(60);
    expect(work()).toBe(2);

    release();
    release();
    expect(work()).toBe(1);
    await sleep(60);
    expect(exit).not.toHaveBeenCalled();

    other();
    expect(work()).toBe(0);
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0, { reason: "drained", open: 0, signal: "SIGTERM" }));
  });

  it("holds the drain open until each hold is released, once", async () => {
    const { drain, exit } = newDrain();
    const a = drain.hold();
    const b = drain.hold();
    drain.start("SIGTERM");
    a();
    a();
    expect(drain.inflight).toBe(1);
    await sleep(60);
    expect(exit).not.toHaveBeenCalled();
    b();
    expect(drain.inflight).toBe(0);
    await vi.waitFor(() => expect(exit).toHaveBeenCalledTimes(1));
  });

  it("answers an upgrade with a bare 503", () => {
    const { drain } = newDrain();
    const socket = { end: vi.fn() };
    drain.rejectUpgrade(socket);
    const reply = socket.end.mock.calls[0][0];
    expect(reply).toMatch(/^HTTP\/1\.1 503 Service Unavailable\r\n/);
    expect(reply).toContain("Retry-After: 5\r\n");
    expect(reply).toContain("Connection: close\r\n");
  });
});

describe("what the drain counts", () => {
  it("counts model traffic, as the socket sees it before rewrites", () => {
    for (const url of ["/v1/chat/completions", "/v1", "/v1?x=1", "/v1/v1/messages", "/api/v1/messages?beta=true",
      "/v1beta/models/x:streamGenerateContent", "/api/v1beta/models", "/codex/responses", "/backend-api/codex/responses",
      "/responses", "/responses?x=1", "/systemone",
      // Next's rewrites match without regard to case.
      "/V1/chat/completions", "/Responses", "/Codex/responses", "/API/V1/messages",
      // Absolute-form request targets.
      "http://example.test/v1/chat/completions", "https://example.test:8443/responses?x=1",
      // Dot segments, resolved as Next resolves them.
      "/./v1/chat/completions", "/api/usage/../../v1/messages", "/dashboard/%2e%2e/v1/models",
      // Percent-encoding, which Next's route lookup also decodes.
      "/api/v%31/chat/completions", "/%76%31/messages"]) {
      expect(isModelTraffic(url), url).toBe(true);
    }
    for (const url of ["/dashboard", "/api/usage/stream", "/api/health", "/api/v10", "/v1x", "/responsesx", "http://example.test/dashboard", "http://example.test",
      "/v1/%2e%2e/api/usage/stream", "/v1/../api/usage/stream", "/v1/%2E%2E/dashboard"]) {
      expect(isModelTraffic(url), url).toBe(false);
    }
  });

  it("knows the dashboard streams that never end", () => {
    for (const url of ["/api/usage/stream", "/api/translator/console-logs/stream", "/api/mcp/browser/sse?x=1",
      "/API/Usage/Stream", "/API/Translator/Console-Logs/Stream", "/Api/MCP/browser/SSE",
      "/v1/%2e%2e/api/usage/stream", "/v1/../api/mcp/browser/sse"]) {
      expect(isLongLived(url), url).toBe(true);
    }
    expect(isLongLived("/api/usage/history")).toBe(false);
  });
});

describe("SHUTDOWN_DRAIN_TIMEOUT_MS", () => {
  it("defaults to 3 minutes when unset", () => {
    expect(DEFAULT_DRAIN_TIMEOUT_MS).toBe(180_000);
    expect(parseDrainTimeout(undefined)).toBe(180_000);
    expect(parseDrainTimeout("")).toBe(180_000);
    expect(parseDrainTimeout("  ")).toBe(180_000);
  });

  it("is off for 0, off and false", () => {
    for (const value of ["0", "off", "OFF", "false", " false "]) expect(parseDrainTimeout(value), value).toBe(0);
  });

  it("takes a whole number of ms, capped at setTimeout's limit", () => {
    expect(parseDrainTimeout("30000")).toBe(30_000);
    expect(parseDrainTimeout("99999999999")).toBe(MAX_DRAIN_TIMEOUT_MS);
    expect(MAX_DRAIN_TIMEOUT_MS).toBe(2147483647);
  });

  it("warns and uses the default for anything else", () => {
    for (const value of ["soon", "-5", "1.5", "10s", "1e3"]) {
      const warn = vi.fn();
      expect(parseDrainTimeout(value, warn), value).toBe(180_000);
      expect(warn, value).toHaveBeenCalledTimes(1);
    }
  });
});

const fakeProcess = (versions = { node: "22.0.0" }) => {
  const proc = new EventEmitter();
  proc.exit = vi.fn();
  proc.versions = versions;
  proc.env = {};
  return proc;
};

describe("shutdown signal gate", () => {
  for (const signal of ["SIGTERM", "SIGINT"]) {
    it(`holds the app's own ${signal} listeners until the drain is over, then runs them all`, async () => {
      const proc = fakeProcess();
      const exitStub = proc.exit;
      const onSignal = vi.fn();
      const runSignalListeners = gateShutdownSignals(proc, onSignal);

      // Like the database adapters: clean up, then exit straight away.
      const calls = [];
      proc.on(signal, () => { calls.push("db"); proc.exit(0); });
      proc.on(signal, () => { calls.push("tunnel"); proc.exit(); });

      proc.emit(signal, signal);
      expect(onSignal).toHaveBeenCalledWith(signal);
      expect(calls).toEqual([]);

      await runSignalListeners(signal);
      expect(calls).toEqual(["db", "tunnel"]);
      expect(exitStub).not.toHaveBeenCalled();
      expect(proc.exit).toBe(exitStub);
    });
  }

  it("waits for an async listener before running the next, and a throwing one skips nothing", async () => {
    const proc = fakeProcess();
    const runSignalListeners = gateShutdownSignals(proc, vi.fn());
    const calls = [];
    proc.on("SIGTERM", async () => {
      await sleep(30);
      calls.push("flush");
    });
    proc.on("SIGTERM", () => { throw new Error("boom"); });
    proc.on("SIGTERM", () => calls.push("close"));

    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await runSignalListeners("SIGTERM");
    error.mockRestore();
    expect(calls).toEqual(["flush", "close"]);
  });

  it("gives all async listeners one shared wait budget", async () => {
    expect(LISTENER_WAIT_MS).toBe(2000);
    const proc = fakeProcess();
    const runSignalListeners = gateShutdownSignals(proc, vi.fn());
    const calls = [];
    proc.on("SIGTERM", () => { calls.push("a"); return sleep(500); });
    proc.on("SIGTERM", () => { calls.push("b"); return sleep(500); });
    const started = Date.now();
    await runSignalListeners("SIGTERM", { waitMs: 600 });
    expect(calls).toEqual(["a", "b"]);
    // 1000 ms if each listener got the budget to itself.
    expect(Date.now() - started).toBeLessThan(850);
  });

  it("passes other events through", () => {
    const proc = fakeProcess();
    gateShutdownSignals(proc, vi.fn());
    const seen = vi.fn();
    proc.on("message", seen);
    proc.emit("message", "hi");
    expect(seen).toHaveBeenCalledWith("hi");
  });
});

describe("installShutdownDrain", () => {
  it("drains on SIGTERM, then runs the app's listeners (async ones awaited) and exits 0", async () => {
    const proc = fakeProcess();
    const { drain } = newDrain();
    expect(installShutdownDrain(proc, drain)).toBe(true);
    expect(proc.env.NEXT_MANUAL_SIG_HANDLE).toBe("true");
    const calls = [];
    proc.on("SIGTERM", async () => { await sleep(50); calls.push("flush"); });

    const release = drain.hold();
    proc.emit("SIGTERM", "SIGTERM");
    await sleep(30);
    expect(calls).toEqual([]);
    release();
    await vi.waitFor(() => expect(proc.exit).toHaveBeenCalledWith(0));
    expect(calls).toEqual(["flush"]);
  });

  it("exits on a second signal without waiting on the listeners", async () => {
    const proc = fakeProcess();
    const { drain } = newDrain({ duplicateWindowMs: 0 });
    installShutdownDrain(proc, drain);
    const never = vi.fn(() => new Promise(() => {}));
    proc.on("SIGINT", never);

    drain.hold();
    proc.emit("SIGTERM", "SIGTERM");
    proc.emit("SIGINT", "SIGINT");
    await vi.waitFor(() => expect(proc.exit).toHaveBeenCalledWith(1), { timeout: 500 });
    expect(never).toHaveBeenCalled();
  });

  it("changes nothing under Bun, whose signals skip process.emit", () => {
    const proc = fakeProcess({ node: "22.0.0", bun: "1.2.0" });
    const emit = proc.emit;
    const { drain } = newDrain();
    expect(installShutdownDrain(proc, drain)).toBe(false);
    expect(proc.emit).toBe(emit);
    expect(proc.listenerCount("SIGTERM")).toBe(0);
    expect(proc.env.NEXT_MANUAL_SIG_HANDLE).toBeUndefined();
  });

  it("changes nothing when the drain is off", () => {
    const proc = fakeProcess();
    const emit = proc.emit;
    const { drain } = newDrain({ timeoutMs: 0 });
    expect(installShutdownDrain(proc, drain)).toBe(false);
    expect(proc.emit).toBe(emit);
    expect(proc.env.NEXT_MANUAL_SIG_HANDLE).toBeUndefined();
  });
});

describe("a budgeted key's usage read after a hang-up", () => {
  it("holds the shutdown from the hang-up until the read ends, once", () => {
    const controller = createStreamController({ drainOnDisconnect: true, drainMaxMs: 5000, log: null, provider: "p", model: "m" });
    controller.handleDisconnect();
    expect(work()).toBe(1);
    controller.endDrain();
    expect(work()).toBe(0);
    controller.endDrain();
    expect(work()).toBe(0);
  });

  it("lets go at the read's own cap", async () => {
    const controller = createStreamController({ drainOnDisconnect: true, drainMaxMs: 20, log: null, provider: "p", model: "m" });
    controller.handleDisconnect();
    expect(work()).toBe(1);
    await vi.waitFor(() => expect(work()).toBe(0));
  });

  it("holds nothing for a key without a budget", () => {
    const controller = createStreamController({ drainOnDisconnect: false, log: null, provider: "p", model: "m" });
    controller.handleDisconnect();
    expect(work()).toBe(0);
    controller.handleComplete();
  });
});
