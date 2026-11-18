import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { PassThrough } from "node:stream";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";

const require = createRequire(import.meta.url);
const { superviseServer } = require("../../cli/src/cli/utils/serverSupervisor.js");
const {
  killServer, checkPortFree, waitServerReady, newLaunchNonce, launchProof, provesLaunchNonce,
  LAUNCH_NONCE_ENV, LAUNCH_CHALLENGE_HEADER, LAUNCH_PROOF_HEADER,
} = require("../../cli/src/cli/utils/serverProcess.js");
const { setupTokenLive, bannerToStdout, SETUP_WINDOW_MS } = require("../../cli/src/cli/utils/launchArgs.js");
const api = require("../../cli/src/cli/api/client.js");
const { isValidHost, parsePort, getBackgroundArgs, serverStdio, createServerOutput, attachServerOutput } = require("../../cli/src/cli/utils/launchArgs.js");
const { interrupt } = require("../../cli/src/cli/utils/input.js");

// Normalized so the line checks hold on a CRLF checkout too.
const source = (rel) => fs.readFileSync(path.resolve(import.meta.dirname, "../..", rel), "utf8").replace(/\r\n/g, "\n");
const cliSource = source("cli/cli.js");
const inputSource = source("cli/src/cli/utils/input.js");

function fakeChild(pid) {
  return Object.assign(new EventEmitter(), { pid, exitCode: null, signalCode: null });
}

// Run due timers, then let the restart's async preflight settle.
async function tick(ms) {
  await vi.advanceTimersByTimeAsync(ms);
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

function harness({ preflight } = {}) {
  const children = [];
  let shuttingDown = false;
  const onExit = vi.fn();
  const onGiveUp = vi.fn();
  const onRestart = vi.fn();
  const supervisor = superviseServer({
    spawn: () => {
      const child = fakeChild(1000 + children.length);
      children.push(child);
      return child;
    },
    preflight,
    isShuttingDown: () => shuttingDown,
    onExit,
    onGiveUp,
    onRestart,
  });
  return {
    supervisor, children, onExit, onGiveUp, onRestart,
    last: () => children.at(-1),
    shutdown: () => { shuttingDown = true; },
  };
}

describe("launcher server supervisor", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("gives up when the third quick start fails (two restarts)", async () => {
    const h = harness();
    await h.supervisor.start();
    h.last().emit("close", 1);
    await tick(1000);
    h.last().emit("close", 1);
    await tick(2000);
    h.last().emit("close", 1);
    expect(h.children).toHaveLength(3);
    expect(h.onRestart.mock.calls.map(([r]) => r.delay)).toEqual([1000, 2000]);
    expect(h.onGiveUp).toHaveBeenCalledWith({ reason: "crash", code: 1, error: undefined, maxRestarts: 2 });
  });

  it("gives up after repeated spawn errors", async () => {
    const h = harness();
    const error = new Error("spawn ENOENT");
    await h.supervisor.start();
    for (const wait of [1000, 2000]) {
      h.last().emit("error", error);
      await tick(wait);
    }
    h.last().emit("error", error);
    expect(h.onGiveUp).toHaveBeenCalledWith(expect.objectContaining({ reason: "crash", error }));
  });

  it("schedules one replacement when a failed spawn emits error then close", async () => {
    const h = harness();
    await h.supervisor.start();
    const error = new Error("spawn ENOENT");
    h.last().emit("error", error);
    h.last().emit("close", -2);
    expect(vi.getTimerCount()).toBe(1);
    expect(h.onRestart).toHaveBeenCalledWith(expect.objectContaining({ error, attempt: 1 }));
    await tick(1000);
    expect(h.children).toHaveLength(2);
  });

  it("schedules one replacement when close comes before error", async () => {
    const h = harness();
    await h.supervisor.start();
    h.last().emit("close", 1);
    h.last().emit("error", new Error("late"));
    expect(vi.getTimerCount()).toBe(1);
    expect(h.onRestart).toHaveBeenCalledTimes(1);
    expect(h.onRestart).toHaveBeenCalledWith(expect.objectContaining({ code: 1, error: undefined }));
  });

  it("does not respawn a crashed child once shutdown has begun", async () => {
    const h = harness();
    await h.supervisor.start();
    h.last().emit("close", 1);
    h.shutdown();
    await tick(5000);
    expect(h.children).toHaveLength(1);
    expect(h.onGiveUp).not.toHaveBeenCalled();
  });

  it("exits 1 on a spawn error during shutdown and 0 on a close", async () => {
    const failing = harness();
    await failing.supervisor.start();
    failing.shutdown();
    failing.last().emit("error", new Error("EPIPE"));
    expect(failing.onExit).toHaveBeenCalledWith(1);

    const stopping = harness();
    await stopping.supervisor.start();
    stopping.shutdown();
    stopping.last().emit("close", null);
    expect(stopping.onExit).toHaveBeenCalledWith(0);
  });

  it("exits with the server on a clean exit", async () => {
    const h = harness();
    await h.supervisor.start();
    h.last().emit("close", 0);
    expect(h.onExit).toHaveBeenCalledWith(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("resets the restart budget after a run that stayed up", async () => {
    const h = harness();
    await h.supervisor.start();
    h.last().emit("close", 1);
    await tick(1000);
    h.last().emit("close", 1);
    await tick(2000);
    await tick(30000);
    h.last().emit("close", 1);
    expect(h.onGiveUp).not.toHaveBeenCalled();
    expect(h.onRestart).toHaveBeenLastCalledWith(expect.objectContaining({ attempt: 1 }));
  });

  it("refuses to spawn when the port is taken, before the first start and before a restart", async () => {
    const taken = Object.assign(new Error("in use"), { code: "EADDRINUSE" });
    const first = harness({ preflight: async () => taken });
    await first.supervisor.start();
    expect(first.children).toHaveLength(0);
    expect(first.onGiveUp).toHaveBeenCalledWith({ reason: "port-taken", error: taken, maxRestarts: 2 });

    const preflight = vi.fn().mockResolvedValueOnce(null).mockResolvedValue(taken);
    const later = harness({ preflight });
    await later.supervisor.start();
    later.last().emit("close", 1);
    await tick(1000);
    expect(later.children).toHaveLength(1);
    expect(later.onGiveUp).toHaveBeenCalledWith(expect.objectContaining({ reason: "port-taken" }));
  });

  it("calls onStart for the first child and every restarted one", async () => {
    const onStart = vi.fn();
    const children = [];
    const supervisor = superviseServer({
      spawn: () => { const c = fakeChild(2000 + children.length); children.push(c); return c; },
      isShuttingDown: () => false, onExit: vi.fn(), onGiveUp: vi.fn(), onStart,
    });
    await supervisor.start();
    children[0].emit("close", 1);
    await tick(1000);
    expect(onStart.mock.calls.map(([c]) => c)).toEqual(children);
    expect(children).toHaveLength(2);
  });

  it("spawns nothing when shutdown starts while the preflight is still running", async () => {
    let finishPreflight;
    const h = harness({ preflight: () => new Promise((resolve) => { finishPreflight = resolve; }) });
    const started = h.supervisor.start();
    h.shutdown();
    finishPreflight(null);
    await started;
    expect(h.children).toHaveLength(0);
    expect(h.onGiveUp).not.toHaveBeenCalled();
  });

  it("ends through onGiveUp, never a rejected promise, when a restart's start throws", async () => {
    const preflight = vi.fn().mockResolvedValueOnce(null).mockRejectedValue(new RangeError("bad port"));
    const h = harness({ preflight });
    await h.supervisor.start();
    h.last().emit("close", 1);
    await tick(1000);
    expect(h.onGiveUp).toHaveBeenCalledWith(expect.objectContaining({ reason: "start-failed", error: expect.any(RangeError) }));
  });
});

describe("stopping our own server", () => {
  it("kills a running server and its process group, even when the direct kill fails", () => {
    const kill = vi.fn((pid) => { if (pid > 0) throw Object.assign(new Error("ESRCH"), { code: "ESRCH" }); });
    expect(killServer(fakeChild(4242), { platform: "linux", kill })).toBe(true);
    expect(kill.mock.calls).toEqual([[4242, "SIGKILL"], [-4242, "SIGKILL"]]);
  });

  it("signals nothing once the child has exited, since its PID may be reused", () => {
    const kill = vi.fn();
    const run = vi.fn();
    expect(killServer(Object.assign(fakeChild(4242), { exitCode: 1 }), { platform: "linux", kill, run })).toBe(false);
    expect(killServer(Object.assign(fakeChild(4242), { signalCode: "SIGKILL" }), { platform: "win32", kill, run })).toBe(false);
    expect(killServer(null, { kill, run })).toBe(false);
    expect(kill).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it("kills the server's process tree with taskkill on Windows", () => {
    const run = vi.fn();
    const kill = vi.fn();
    killServer(fakeChild(4242), { platform: "win32", kill, run });
    expect(run).toHaveBeenCalledWith("taskkill", ["/F", "/T", "/PID", "4242"], expect.any(Object));
    expect(kill).not.toHaveBeenCalled();
  });

  it("hands Ctrl+C from the raw-mode menu to the launcher's SIGINT handler", () => {
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {});
    const onSigint = vi.fn();
    process.on("SIGINT", onSigint);
    try {
      interrupt();
      expect(onSigint).toHaveBeenCalledTimes(1);
      expect(exit).not.toHaveBeenCalled();
    } finally {
      process.off("SIGINT", onSigint);
      exit.mockRestore();
    }
  });

  it("registers an exit handler that stops our server on every exit path", () => {
    expect(cliSource).toMatch(/^\s*process\.on\("exit", \(\) => killServer\(supervisor\.current\(\)\)\);$/m);
  });

  it("routes every Ctrl+C in input.js through interrupt(), never process.exit(0)", () => {
    expect(inputSource).toMatch(/^ {6}if \(key\.ctrl && key\.name === "c"\) \{ cleanup\(\); interrupt\(\); \}$/m);
    expect(inputSource.match(/^ {4}rl\.on\("SIGINT", \(\) => \{ rl\.close\(\); interrupt\(\); \}\);$/gm)).toHaveLength(2);
    expect(inputSource).not.toContain("process.exit(0)");
  });

  it("releases the DATA_DIR lock after cleanup and before the tray handoff spawns", () => {
    const cleanup = cliSource.search(/^ {10}cleanup\(\);\n {10}lock\.release\(\);$/m);
    const spawnBg = cliSource.search(/^ {10}const bgProcess = spawn\(/m);
    expect(cleanup).toBeGreaterThan(-1);
    expect(spawnBg).toBeGreaterThan(cleanup);
  });
});

function listen(host = "127.0.0.1") {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => socket.destroy());
    server.listen({ host, port: 0 }, () => resolve(server));
  });
}
const close = (server) => new Promise((resolve) => server.close(resolve));

describe("port preflight", () => {
  it("passes for a free port", async () => {
    const probe = await listen();
    const { port } = probe.address();
    await close(probe);
    expect(await checkPortFree({ host: "127.0.0.1", dialHost: "127.0.0.1", port, attempts: 1 })).toBeNull();
  });

  it("refuses when something already listens on the address", async () => {
    const occupant = await listen();
    try {
      const reason = await checkPortFree({ host: "127.0.0.1", dialHost: "127.0.0.1", port: occupant.address().port, attempts: 1 });
      expect(reason?.code).toBe("EADDRINUSE");
    } finally {
      await close(occupant);
    }
  });

  // Linux lets 127.0.0.1:P bind beside 192.168.x.y:P, and macOS a specific
  // address beside 0.0.0.0:P, so a listener on the dial address must block
  // even when the bind would work.
  it("refuses when the dial address answers even though the bind would succeed", async () => {
    const createServer = vi.fn();
    const connect = () => {
      const socket = Object.assign(new EventEmitter(), { setTimeout() {}, destroy() {} });
      queueMicrotask(() => socket.emit("connect"));
      return socket;
    };
    const reason = await checkPortFree({ host: "127.0.0.1", dialHost: "127.0.0.1", port: 20128, attempts: 1, net: { connect, createServer } });
    expect(reason?.code).toBe("EADDRINUSE");
    expect(createServer).not.toHaveBeenCalled();
  });

  it("stops retrying on a bind error that waiting can't fix", async () => {
    const connect = () => {
      const socket = Object.assign(new EventEmitter(), { setTimeout() {}, destroy() {} });
      queueMicrotask(() => socket.emit("error", new Error("ECONNREFUSED")));
      return socket;
    };
    const createServer = vi.fn(() => {
      const server = Object.assign(new EventEmitter(), {
        listen() { queueMicrotask(() => server.emit("error", Object.assign(new Error("not here"), { code: "EADDRNOTAVAIL" }))); },
      });
      return server;
    });
    const reason = await checkPortFree({ host: "192.0.2.1", dialHost: "192.0.2.1", port: 20128, attempts: 5, net: { connect, createServer } });
    expect(reason.code).toBe("EADDRNOTAVAIL");
    expect(createServer).toHaveBeenCalledTimes(1);
  });
});

// An HTTP server on 127.0.0.1 that answers /api/health like ours would, given
// a nonce, or like any other program, without one.
function healthServer(nonce) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const challenge = req.headers[LAUNCH_CHALLENGE_HEADER];
      const headers = { "content-type": "application/json" };
      if (nonce && req.url === "/api/health" && challenge) headers[LAUNCH_PROOF_HEADER] = launchProof(nonce, challenge);
      res.writeHead(200, headers);
      res.end('{"ok":true}');
    });
    server.listen({ host: "127.0.0.1", port: 0 }, () => resolve(server));
  });
}

describe("readiness is gated on our own child", () => {
  it("accepts only a server that proves the launch nonce", async () => {
    const nonce = newLaunchNonce();
    const ours = await healthServer(nonce);
    const occupant = await healthServer(null);
    const impostor = await healthServer(newLaunchNonce());
    try {
      expect(await provesLaunchNonce({ host: "127.0.0.1", port: ours.address().port, nonce })).toBe(true);
      expect(await provesLaunchNonce({ host: "127.0.0.1", port: occupant.address().port, nonce })).toBe(false);
      expect(await provesLaunchNonce({ host: "127.0.0.1", port: impostor.address().port, nonce })).toBe(false);
      expect(await provesLaunchNonce({ host: "127.0.0.1", port: 9, nonce })).toBe(false);
    } finally {
      await Promise.all([close(ours), close(occupant), close(impostor)]);
    }
  });

  it("the server's /api/health answers the challenge with the same proof", async () => {
    const nonce = newLaunchNonce();
    vi.stubEnv(LAUNCH_NONCE_ENV, nonce);
    try {
      const { GET } = await import("../../src/app/api/health/route.js");
      const challenge = "0123456789abcdef0123456789abcdef";
      const res = await GET(new Request("http://127.0.0.1/api/health", { headers: { [LAUNCH_CHALLENGE_HEADER]: challenge } }));
      expect(res.headers.get(LAUNCH_PROOF_HEADER)).toBe(launchProof(nonce, challenge));
      const plain = await GET(new Request("http://127.0.0.1/api/health"));
      expect(plain.headers.get(LAUNCH_PROOF_HEADER)).toBeNull();
      const odd = await GET(new Request("http://127.0.0.1/api/health", { headers: { [LAUNCH_CHALLENGE_HEADER]: "not hex" } }));
      expect(odd.headers.get(LAUNCH_PROOF_HEADER)).toBeNull();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("names the nonce env and headers the way the server does", async () => {
    const server = await import("../../src/lib/launchProof.js");
    expect([server.LAUNCH_NONCE_ENV, server.LAUNCH_CHALLENGE_HEADER, server.LAUNCH_PROOF_HEADER]).toEqual([LAUNCH_NONCE_ENV, LAUNCH_CHALLENGE_HEADER, LAUNCH_PROOF_HEADER]);
    expect(server.launchProof("n", "c")).toBe(launchProof("n", "c"));
  });

  it("waits while the child is dead or the answer isn't ours", async () => {
    let alive = false;
    let ours = false;
    const isOurs = vi.fn(async () => ours);
    const ready = waitServerReady({ isAlive: () => alive, isStopped: () => false, isOurs, intervalMs: 5 });
    const early = await Promise.race([ready, new Promise((r) => setTimeout(() => r("still waiting"), 60))]);
    expect(early).toBe("still waiting");
    expect(isOurs).not.toHaveBeenCalled();
    alive = true;
    const later = await Promise.race([ready, new Promise((r) => setTimeout(() => r("still waiting"), 60))]);
    expect(later).toBe("still waiting");
    ours = true;
    expect(await ready).toBe("ready");
  });

  it("stops waiting on shutdown", async () => {
    let stopped = false;
    const ready = waitServerReady({ isAlive: () => false, isStopped: () => stopped, isOurs: async () => true, intervalMs: 10 });
    stopped = true;
    expect(await ready).toBe("stopped");
  });

  it("says it is still waiting, then times out", async () => {
    vi.useFakeTimers();
    try {
      const onWaiting = vi.fn();
      const status = waitServerReady({
        isAlive: () => false, isStopped: () => false, isOurs: async () => true,
        timeoutMs: 120000, noticeMs: 15000, onWaiting, intervalMs: 150,
      });
      await vi.advanceTimersByTimeAsync(120200);
      expect(await status).toBe("timeout");
      expect(onWaiting.mock.calls.map(([ms]) => Math.round(ms / 15000))).toEqual([1, 2, 3, 4, 5, 6, 7]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("re-checks readiness after every (re)start, and the API client waits for it", () => {
    expect(cliSource).toMatch(/^ {4}onStart: \(\) => \{\n {6}readiness = ownServerReady\(\);\n {6}api\.pauseUntil\(readiness\);\n/m);
    expect(cliSource).toMatch(/^ {2}api\.pauseUntil\(serverReady\(\)\);$/m);
    expect(cliSource).toMatch(/^ {8}\[LAUNCH_NONCE_ENV\]: launchNonce,$/m);
    expect(cliSource).toMatch(/isOurs: \(\) => provesLaunchNonce\(\{ host: dialHost, port, nonce: launchNonce \}\)/);
  });
});

describe("API client gate", () => {
  afterEach(() => { api.pauseUntil(null); vi.restoreAllMocks(); });

  it("sends nothing, CLI token included, until readiness passes", async () => {
    const request = vi.spyOn(http, "request");
    api.pauseUntil(Promise.resolve(false));
    const result = await api.getTunnelStatus();
    expect(result.success).toBe(false);
    expect(request).not.toHaveBeenCalled();
  });

  it("holds requests while readiness is pending, then sends them", async () => {
    const request = vi.spyOn(http, "request").mockImplementation(() => {
      const req = Object.assign(new EventEmitter(), { write() {}, end() { queueMicrotask(() => req.emit("error", new Error("stub"))); }, setTimeout() {}, destroy() {} });
      return req;
    });
    let pass;
    api.pauseUntil(new Promise((resolve) => { pass = resolve; }));
    const pending = api.getTunnelStatus();
    await new Promise((r) => setTimeout(r, 20));
    expect(request).not.toHaveBeenCalled();
    pass(true);
    await pending;
    expect(request).toHaveBeenCalledTimes(1);
  });
});

describe("server output", () => {
  function fakeServer() {
    return { stdout: new PassThrough(), stderr: new PassThrough() };
  }
  const ended = (stream) => new Promise((resolve) => stream.once("end", resolve));

  it("consumes piped stdout and stderr, so a chatty server never blocks on a full pipe", async () => {
    const child = fakeServer();
    const logged = [];
    attachServerOutput(child, { show: () => {}, log: (l) => logged.push(l) });
    expect(child.stdout.readableFlowing).toBe(true);
    expect(child.stderr.readableFlowing).toBe(true);
    const line = `GET /v1/models 200 ${"x".repeat(200)}\n`;
    for (let i = 0; i < 2000; i++) child.stdout.write(line);
    child.stderr.write("warn: one\nwarn: t");
    child.stderr.end("wo\n");
    child.stdout.end();
    await Promise.all([ended(child.stdout), ended(child.stderr)]);
    expect(logged.filter((l) => l.startsWith("GET"))).toHaveLength(2000);
    expect(logged).toContain("warn: two");
  });

  it("keeps a ─ split across two chunks whole, and hands over the whole banner", async () => {
    const child = fakeServer();
    const shown = [];
    const banners = [];
    attachServerOutput(child, { show: (l) => shown.push(l), log: () => {}, onBanner: (b) => banners.push(b) });
    const rule = "─".repeat(64);
    const bytes = Buffer.from(`${rule}\n  token: tok-placeholder\n${rule}\n`, "utf8");
    // Cut inside the first "─" (3 bytes in UTF-8).
    child.stdout.write(bytes.subarray(0, 1));
    child.stdout.write(bytes.subarray(1));
    child.stdout.end();
    await ended(child.stdout);
    expect(shown).toEqual([rule, "  token: tok-placeholder", rule]);
    expect(banners).toEqual([`${rule}\n  token: tok-placeholder\n${rule}`]);
  });

  it("keeps the banner for the menu, since the menu redraw clears the screen", () => {
    expect(cliSource).toMatch(/^\s*setupBanner = text;$/m);
    expect(cliSource).toMatch(/selectMenu\(`Choose Interface \(v\$\{pkg\.version\}\)`, menuItems, 0, subtitle, setupPending \? setupBanner : ""\)/);
    expect(cliSource).toMatch(/^ {2}const setupPending = setupBanner && setupTokenLive\(path\.join\(getDataDir\(\), "setup-token\.json"\)\);$/m);
  });

  it("drops the banner from the menu once the token file is gone or the token expired", () => {
    const now = 1_800_000_000_000;
    const file = (createdAt) => () => JSON.stringify({ token: "t", createdAt });
    expect(setupTokenLive("/f", { now, readFile: file(now - 60_000) })).toBe(true);
    expect(setupTokenLive("/f", { now, readFile: file(now - SETUP_WINDOW_MS) })).toBe(false);
    expect(setupTokenLive("/f", { now, readFile: () => { throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); } })).toBe(false);
    expect(setupTokenLive("/f", { now, readFile: () => "garbage" })).toBe(false);
  });

  it("uses the server's setup window", async () => {
    const { SETUP_WINDOW_MS: serverWindow } = await import("../../src/lib/auth/setupToken.js");
    expect(SETUP_WINDOW_MS).toBe(serverWindow);
  });

  // The journal and ~/.xsession-errors are often readable by other users.
  it("keeps the token out of stdout for Linux tray and autostart runs", () => {
    expect(bannerToStdout({ platform: "linux", trayMode: true, autostart: false })).toBe(false);
    expect(bannerToStdout({ platform: "linux", trayMode: false, autostart: true })).toBe(false);
    expect(bannerToStdout({ platform: "linux", trayMode: false, autostart: false })).toBe(true);
    expect(bannerToStdout({ platform: "darwin", trayMode: true, autostart: true })).toBe(true);
    expect(bannerToStdout({ platform: "win32", trayMode: true, autostart: false })).toBe(true);
    expect(cliSource).toMatch(/^ {2}const showBanner = bannerToStdout\(\{ trayMode, autostart: process\.env\[AUTOSTART_ENV\] === "1" \}\);$/m);
    expect(cliSource).toMatch(/^ {8}show: showBanner \? \(line\) => console\.log\(line\) : \(\) => \{\},$/m);
  });

  it("shows only the setup banner and keeps every other line for the crash log", async () => {
    const shown = [];
    const logged = [];
    const output = createServerOutput({ show: (l) => shown.push(l), log: (l) => logged.push(l) });
    const print = vi.spyOn(console, "log").mockImplementation((text) => {
      const s = `${text}\n`;
      // Split mid-line to model pipe chunking.
      output.write(s.slice(0, 7));
      output.write(s.slice(7));
    });
    try {
      const { printSetupBanner } = await import("../../src/lib/auth/setupToken.js");
      output.write("GET /api/health 200 in 3ms\n");
      printSetupBanner("tok-placeholder-123");
      output.write("POST /v1/chat/completions 200 in 900ms\n");
      output.end();
    } finally {
      print.mockRestore();
    }
    expect(shown.join("\n")).toContain("tok-placeholder-123");
    expect(shown.some((l) => l.includes("/v1/"))).toBe(false);
    expect(logged).toEqual(["GET /api/health 200 in 3ms", "POST /v1/chat/completions 200 in 900ms"]);
  });

  it("pipes server stdout unless --log is given", () => {
    expect(serverStdio(false)).toEqual(["ignore", "pipe", "pipe"]);
    expect(serverStdio(true)).toBe("inherit");
    expect(cliSource).toContain("stdio: serverStdio(showLog),");
  });
});

describe("launch options", () => {
  it.each(["127.0.0.1", "0.0.0.0", "::", "::1", "192.168.1.5", "localhost", "my-host.lan"])("accepts --host %s", (host) => {
    expect(isValidHost(host)).toBe(true);
  });

  it.each(["", "a b", 'x"y', "x'y", "x\r\ny", "x\ny", "x;rm", "$(id)", "x`y`", "x%PATH%", "-x", "[::1]"])("rejects --host %j", (host) => {
    expect(isValidHost(host)).toBe(false);
  });

  it("carries the bind and port into a tray relaunch", () => {
    expect(getBackgroundArgs({ host: "127.0.0.1", port: 20200 })).toEqual(["--tray", "--skip-update", "--port", "20200", "--host", "127.0.0.1"]);
    expect(cliSource).toMatch(/^\s*const bgProcess = spawn\(process\.execPath, \["--dns-result-order=ipv4first", __filename, \.\.\.getBackgroundArgs\(\{ port, host \}\)\]/m);
    expect(() => getBackgroundArgs({ port: 20200 })).toThrow();
  });

  it.each([["20200", 20200], ["1", 1], ["65535", 65535], ["0", null], ["abc", null], ["65536", null], ["-1", null], ["20200abc", null], ["", null], [" 20200", null], ["2e4", null], [undefined, null]])("parses --port %j as %j", (text, expected) => {
    expect(parsePort(text)).toBe(expected);
  });

  it("writes autostart with the running bind, port and DATA_DIR", () => {
    expect(cliSource).toMatch(/^\s*const autostartLaunch = \{ port, host, dataDir: process\.env\.DATA_DIR \|\| "" \};$/m);
    expect(cliSource).toMatch(/^\s*enableAutoStart\(__filename, autostartLaunch\);$/m);
    expect(cliSource).toMatch(/^\s*autostart: autostartLaunch,$/m);
  });

  it("skips the PID-file tunnel only when give-up was a port conflict", () => {
    expect(cliSource).toMatch(/^\s*cleanup\(\{ killPidFileTunnel: reason === "crash" \}\);$/m);
  });

  it("supervises the server before the tray-only branch returns", () => {
    const start = cliSource.search(/^ {2}supervisor\.start\(\)/m);
    const trayBranch = cliSource.search(/^ {2}if \(trayMode\) \{$/m);
    expect(start).toBeGreaterThan(-1);
    expect(trayBranch).toBeGreaterThan(start);
  });

  // The self-heal runs npm in $DATA_DIR/runtime; a planted .npmrc there would
  // run code before the check could refuse the directory.
  it("checks an autostart DATA_DIR before the npm self-heal runs", () => {
    const check = cliSource.search(/^ {2}const unsafe = unsafeDataDirReason\(process\.env\.DATA_DIR\);$/m);
    const sqlite = cliSource.search(/^try \{ ensureSqliteRuntime\(\{ silent: true \}\); \} catch \{\}$/m);
    const tray = cliSource.search(/^try \{ ensureTrayRuntime\(\{ silent: true \}\); \} catch \{\}$/m);
    expect(check).toBeGreaterThan(-1);
    expect(sqlite).toBeGreaterThan(check);
    expect(tray).toBeGreaterThan(check);
  });

  // A top-level binding declared below the startup call is still in its
  // temporal dead zone if startup reaches it synchronously.
  it("declares every top-level binding before it starts the launcher", () => {
    const call = cliSource.search(/^acquireDataDirLock\(/m);
    expect(call).toBeGreaterThan(-1);
    expect(cliSource.slice(call)).not.toMatch(/^(const|let|var|class)\b/m);
  });
});
