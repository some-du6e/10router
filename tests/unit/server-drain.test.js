import { afterEach, describe, expect, it, vi } from "vitest";
import http from "node:http";
import net from "node:net";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { GET as healthGET } from "../../src/app/api/health/route.js";

const require = createRequire(import.meta.url);
const {
  DEFAULT_DRAIN_TIMEOUT_MS,
  DRAINING_KEY,
  createDrain,
  gateShutdownSignals,
  parseDrainTimeout,
} = require("../../server-drain.js");

const servers = [];

afterEach(async () => {
  delete globalThis[DRAINING_KEY];
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(() => resolve()));
  }
});

// A server whose /slow response sends one SSE event, then waits for release()
// before sending the last one, like a long model stream.
async function startServer(drain) {
  let release;
  const released = new Promise((resolve) => { release = resolve; });
  const server = http.createServer(async (req, res) => {
    if (!drain.track(req, res)) return;
    if (req.url === "/slow") {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write("data: first\n\n");
      await released;
      res.end("data: last\n\n");
      return;
    }
    res.end("ok");
  });
  drain.addServer(server);
  servers.push(server);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, port: server.address().port, release };
}

// Starts GET /slow; `started` resolves on the first event, `body` with everything.
function startSlowStream(port) {
  let onStarted;
  const started = new Promise((resolve) => { onStarted = resolve; });
  const body = new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port, path: "/slow", agent: false }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { text += chunk; onStarted(); });
      res.on("end", () => resolve(text));
      res.on("error", reject);
    }).on("error", reject);
  });
  return { started, body };
}

function connect(port) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

describe("server drain on shutdown", () => {
  it("lets an in-flight stream finish, refuses new connections, then exits 0", async () => {
    const exit = vi.fn();
    const logs = [];
    const drain = createDrain({ timeoutMs: 10_000, exit, log: (line) => logs.push(line) });
    const { port, release } = await startServer(drain);

    const slow = startSlowStream(port);
    await slow.started;
    drain.start("SIGTERM");

    expect(drain.draining).toBe(true);
    expect(logs[0]).toContain("draining 1 in-flight request(s)");
    expect(exit).not.toHaveBeenCalled();

    await expect(connect(port)).rejects.toMatchObject({ code: "ECONNREFUSED" });
    expect(exit).not.toHaveBeenCalled();

    release();
    expect(await slow.body).toBe("data: first\n\ndata: last\n\n");
    await vi.waitFor(() => expect(exit).toHaveBeenCalledTimes(1));
    expect(exit).toHaveBeenCalledWith(0, { reason: "drained", open: 0, signal: "SIGTERM" });
    expect(logs.at(-1)).toMatch(/drained in \d+s, exiting/);
  });

  it("answers a request on an open keep-alive socket with 503 + Retry-After + Connection: close", async () => {
    const exit = vi.fn();
    const drain = createDrain({ timeoutMs: 10_000, exit, log: () => {} });
    const { server, port, release } = await startServer(drain);
    const sawNew = new Promise((resolve) => server.on("request", (req) => { if (req.url === "/new") resolve(); }));

    const socket = await connect(port);
    let raw = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => { raw += chunk; });
    const closed = new Promise((resolve) => socket.on("close", resolve));
    socket.write(`GET /slow HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: keep-alive\r\n\r\n`);
    await vi.waitFor(() => expect(raw).toContain("data: first"));

    drain.start("SIGTERM");
    // Same socket, after the drain started: must not reach the handler.
    socket.write(`GET /new HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: keep-alive\r\n\r\n`);
    await sawNew;
    release();
    await closed;

    const second = raw.slice(raw.indexOf("HTTP/1.1", 1));
    expect(raw).toContain("data: last");
    expect(second).toMatch(/^HTTP\/1\.1 503/);
    expect(second).toMatch(/\r\nRetry-After: 5\r\n/i);
    expect(second).toMatch(/\r\nConnection: close\r\n/i);
    expect(second).toContain("server_draining");
    expect(second).not.toContain("ok");
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0, { reason: "drained", open: 0, signal: "SIGTERM" }));
  });

  it("exits on timeout with the count still open", async () => {
    const exit = vi.fn();
    const logs = [];
    const drain = createDrain({ timeoutMs: 150, exit, log: (line) => logs.push(line) });
    const { port, release } = await startServer(drain);

    const slow = startSlowStream(port);
    await slow.started;
    drain.start("SIGTERM");

    await vi.waitFor(() => expect(exit).toHaveBeenCalledTimes(1), { timeout: 2000 });
    expect(exit).toHaveBeenCalledWith(1, { reason: "timeout", open: 1, signal: "SIGTERM" });
    expect(logs.at(-1)).toContain("1 request(s) still open");
    release();
    await slow.body;
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it("exits at once on a second signal", async () => {
    const exit = vi.fn();
    const drain = createDrain({ timeoutMs: 10_000, exit, log: () => {} });
    const { port, release } = await startServer(drain);

    const slow = startSlowStream(port);
    await slow.started;
    drain.start("SIGTERM");
    expect(exit).not.toHaveBeenCalled();
    drain.start("SIGINT");
    expect(exit).toHaveBeenCalledWith(1, { reason: "signal", open: 1, signal: "SIGINT" });

    release();
    await slow.body;
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it("exits at once when SHUTDOWN_DRAIN_TIMEOUT_MS=0", async () => {
    expect(parseDrainTimeout("0")).toBe(0);
    const exit = vi.fn();
    const drain = createDrain({ timeoutMs: parseDrainTimeout("0"), exit, log: () => {} });
    const { port, release } = await startServer(drain);

    const slow = startSlowStream(port);
    await slow.started;
    drain.start("SIGTERM");
    expect(exit).toHaveBeenCalledWith(0, { reason: "disabled", open: 1, signal: "SIGTERM" });
    expect(drain.draining).toBe(false);
    release();
    await slow.body;
  });

  it("defaults to 10 minutes for an unset or invalid timeout", () => {
    expect(DEFAULT_DRAIN_TIMEOUT_MS).toBe(600_000);
    expect(parseDrainTimeout(undefined)).toBe(600_000);
    expect(parseDrainTimeout("")).toBe(600_000);
    expect(parseDrainTimeout("soon")).toBe(600_000);
    expect(parseDrainTimeout("-5")).toBe(600_000);
    expect(parseDrainTimeout("30000")).toBe(30_000);
  });
});

describe("shutdown signal gate", () => {
  it("holds the app's own signal listeners until the drain is over, then runs them all", () => {
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

    proc.emit("other", 1);
    runSignalListeners("SIGTERM");
    expect(calls).toEqual(["db", "tunnel"]);
    expect(exitStub).not.toHaveBeenCalled();
    expect(proc.exit).toBe(exitStub);
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

describe("/api/health", () => {
  it("is 200 while serving and 503 while draining", async () => {
    const ok = await healthGET();
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true });

    const drain = createDrain({ timeoutMs: 10_000, exit: vi.fn(), log: () => {} });
    drain.start("SIGTERM");

    const draining = await healthGET();
    expect(draining.status).toBe(503);
    expect(draining.headers.get("retry-after")).toBe("5");
    expect(await draining.json()).toEqual({ ok: false, draining: true });
  });
});
