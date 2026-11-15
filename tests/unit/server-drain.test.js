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
  MAX_DRAIN_TIMEOUT_MS,
  createDrain,
  gateShutdownSignals,
  isLongLived,
  isModelTraffic,
  parseDrainTimeout,
} = require("../../server-drain.js");

const servers = [];

afterEach(async () => {
  delete globalThis[BACKGROUND_WORK_KEY];
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(() => resolve()));
  }
});

const newDrain = (options = {}) => {
  const exit = vi.fn();
  const logs = [];
  const drain = createDrain({ timeoutMs: 10_000, flushMs: 10, exit, log: (line) => logs.push(line), ...options });
  return { drain, exit, logs };
};

// GET /v1/slow?id=x (and any other path ending in /slow?id=x) sends one SSE
// event, then waits for release(x) before the last one, like a model stream.
// A POST reads its whole body first. Anything else answers "ok" at once.
async function startServer(drain) {
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
  drain.addServer(server);
  servers.push(server);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, port: server.address().port, release: (id = "default") => gate(id).open() };
}

// Starts a GET; `started` resolves on the first bytes, `body` with the rest
// (`complete: false` when the connection is cut).
function startStream(port, path) {
  let onStarted;
  const started = new Promise((resolve) => { onStarted = resolve; });
  let request;
  const body = new Promise((resolve) => {
    let text = "";
    request = http.get({ host: "127.0.0.1", port, path, agent: false }, (res) => {
      res.setEncoding("utf8");
      res.on("data", (chunk) => { text += chunk; onStarted(); });
      res.on("end", () => resolve({ text, complete: true }));
      res.on("error", () => resolve({ text, complete: false }));
      res.on("aborted", () => resolve({ text, complete: false }));
    });
    request.on("error", () => resolve({ text, complete: false }));
  });
  return { started, body, abort: () => request.destroy() };
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
    await new Promise((resolve) => setTimeout(resolve, 60));
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

  it("closes an idle keep-alive socket when the drain starts", async () => {
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
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(exit).not.toHaveBeenCalled();

    release();
    expect((await model.body).complete).toBe(true);
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0, { reason: "drained", open: 0, signal: "SIGTERM" }));
  });

  it("cuts a request still trickling its body", async () => {
    const { drain, exit, logs } = newDrain({ bodyTimeoutMs: 100 });
    const { port } = await startServer(drain);

    const socket = await connect(port);
    const closed = new Promise((resolve) => socket.on("close", resolve));
    socket.on("error", () => {});
    socket.write(`POST /v1/chat/completions HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 1000\r\n\r\n{"mo`);
    await vi.waitFor(() => expect(drain.inflight).toBe(1));

    drain.start("SIGTERM");
    const trickle = setInterval(() => socket.write(" "), 20);
    await closed;
    clearInterval(trickle);
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0, { reason: "drained", open: 0, signal: "SIGTERM" }));
    expect(logs.join("\n")).toContain("closed 1 request(s) still sending their body");
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

  it("ignores a repeat signal right after the first, and exits at once on a later one", async () => {
    const { drain, exit } = newDrain({ duplicateWindowMs: 100 });
    const { port, release } = await startServer(drain);

    const slow = startStream(port, "/v1/slow");
    await slow.started;
    drain.start("SIGINT");
    drain.start("SIGTERM");
    expect(exit).not.toHaveBeenCalled();

    await new Promise((resolve) => setTimeout(resolve, 150));
    drain.start("SIGINT");
    expect(exit).toHaveBeenCalledWith(1, { reason: "signal", open: 1, signal: "SIGINT" });

    release();
    await slow.body;
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it("exits at once when SHUTDOWN_DRAIN_TIMEOUT_MS=0", async () => {
    const { drain, exit } = newDrain({ timeoutMs: parseDrainTimeout("0") });
    const { port, release } = await startServer(drain);

    const slow = startStream(port, "/v1/slow");
    await slow.started;
    drain.start("SIGTERM");
    expect(exit).toHaveBeenCalledWith(0, { reason: "disabled", open: 1, signal: "SIGTERM" });
    expect(drain.draining).toBe(false);
    release();
    await slow.body;
  });

  it("waits for work registered with holdShutdown, like a budgeted key's usage read", async () => {
    const { drain, exit } = newDrain();
    const release = holdShutdown();
    drain.start("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(drain.inflight).toBe(1);
    expect(exit).not.toHaveBeenCalled();

    release();
    release();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0, { reason: "drained", open: 0, signal: "SIGTERM" }));
  });

  it("holds the drain open until a hold is released", async () => {
    const { drain, exit } = newDrain();
    const release = drain.hold();
    drain.start("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(exit).not.toHaveBeenCalled();
    release();
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
    for (const url of ["/v1/chat/completions", "/v1", "/v1/v1/messages", "/api/v1/messages?beta=true", "/v1beta/models/x:streamGenerateContent",
      "/api/v1beta/models", "/codex/responses", "/backend-api/codex/responses", "/responses", "/systemone"]) {
      expect(isModelTraffic(url), url).toBe(true);
    }
    for (const url of ["/dashboard", "/api/usage/stream", "/api/health", "/api/v10", "/v1x", "/responsesx"]) {
      expect(isModelTraffic(url), url).toBe(false);
    }
  });

  it("knows the dashboard streams that never end", () => {
    for (const url of ["/api/usage/stream", "/api/translator/console-logs/stream", "/api/mcp/browser/sse?x=1"]) {
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

describe("shutdown signal gate", () => {
  it("holds the app's own signal listeners until the drain is over, then runs them all", async () => {
    const proc = new EventEmitter();
    const exitStub = vi.fn();
    proc.exit = exitStub;
    const onSignal = vi.fn();
    const runSignalListeners = gateShutdownSignals(proc, onSignal);

    // Like the database adapters: clean up, then exit straight away.
    const calls = [];
    proc.on("SIGTERM", () => { calls.push("db"); proc.exit(0); });
    proc.on("SIGTERM", () => { calls.push("tunnel"); proc.exit(); });

    proc.emit("SIGTERM", "SIGTERM");
    expect(onSignal).toHaveBeenCalledWith("SIGTERM");
    expect(calls).toEqual([]);

    await runSignalListeners("SIGTERM");
    expect(calls).toEqual(["db", "tunnel"]);
    expect(exitStub).not.toHaveBeenCalled();
    expect(proc.exit).toBe(exitStub);
  });

  it("waits for an async listener before running the next, and a throwing one skips nothing", async () => {
    const proc = new EventEmitter();
    proc.exit = vi.fn();
    const runSignalListeners = gateShutdownSignals(proc, vi.fn());
    const calls = [];
    proc.on("SIGTERM", async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      calls.push("flush");
    });
    proc.on("SIGTERM", () => { throw new Error("boom"); });
    proc.on("SIGTERM", () => calls.push("close"));

    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await runSignalListeners("SIGTERM");
    error.mockRestore();
    expect(calls).toEqual(["flush", "close"]);
  });

  it("gives async listeners a bounded wait", async () => {
    const proc = new EventEmitter();
    proc.exit = vi.fn();
    const runSignalListeners = gateShutdownSignals(proc, vi.fn());
    proc.on("SIGTERM", () => new Promise(() => {}));
    const started = Date.now();
    await runSignalListeners("SIGTERM", { waitMs: 50 });
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("passes other events through", () => {
    const proc = new EventEmitter();
    proc.exit = vi.fn();
    gateShutdownSignals(proc, vi.fn());
    const seen = vi.fn();
    proc.on("message", seen);
    proc.emit("message", "hi");
    expect(seen).toHaveBeenCalledWith("hi");
  });
});

describe("a budgeted key's usage read after a hang-up", () => {
  const count = () => globalThis[BACKGROUND_WORK_KEY]?.count ?? 0;

  it("holds the shutdown from the hang-up until the read ends", () => {
    const controller = createStreamController({ drainOnDisconnect: true, drainMaxMs: 5000, log: null, provider: "p", model: "m" });
    controller.handleDisconnect();
    expect(count()).toBe(1);
    controller.endDrain();
    expect(count()).toBe(0);
    controller.endDrain();
    expect(count()).toBe(0);
  });

  it("lets go at the read's own cap", async () => {
    const controller = createStreamController({ drainOnDisconnect: true, drainMaxMs: 20, log: null, provider: "p", model: "m" });
    controller.handleDisconnect();
    expect(count()).toBe(1);
    await vi.waitFor(() => expect(count()).toBe(0));
  });

  it("holds nothing for a key without a budget", () => {
    const controller = createStreamController({ drainOnDisconnect: false, log: null, provider: "p", model: "m" });
    controller.handleDisconnect();
    expect(count()).toBe(0);
    controller.handleComplete();
  });
});
