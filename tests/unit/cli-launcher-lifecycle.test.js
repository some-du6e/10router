import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { PassThrough } from "node:stream";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

const require = createRequire(import.meta.url);
const { superviseServer } = require("../../cli/src/cli/utils/serverSupervisor.js");
const { killServer, checkPortFree, waitServerReady } = require("../../cli/src/cli/utils/serverProcess.js");
const { isValidHost, parsePort, getBackgroundArgs, serverStdio, createServerOutput, attachServerOutput } = require("../../cli/src/cli/utils/launchArgs.js");
const { interrupt } = require("../../cli/src/cli/utils/input.js");

const cliSource = fs.readFileSync(path.resolve(import.meta.dirname, "../../cli/cli.js"), "utf8");
const inputSource = fs.readFileSync(path.resolve(import.meta.dirname, "../../cli/src/cli/utils/input.js"), "utf8");

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

describe("readiness is gated on our own child", () => {
  it("doesn't report a port occupant as our server", async () => {
    const occupant = await listen();
    let alive = false;
    try {
      const ready = waitServerReady({ dialHost: "127.0.0.1", port: occupant.address().port, isAlive: () => alive, isStopped: () => false, intervalMs: 10 });
      const early = await Promise.race([ready, new Promise((r) => setTimeout(() => r("still waiting"), 150))]);
      expect(early).toBe("still waiting");
      alive = true;
      expect(await ready).toBe("ready");
    } finally {
      await close(occupant);
    }
  });

  it("stops waiting on shutdown", async () => {
    let stopped = false;
    const ready = waitServerReady({ dialHost: "127.0.0.1", port: 9, isAlive: () => false, isStopped: () => stopped, intervalMs: 10 });
    stopped = true;
    expect(await ready).toBe("stopped");
  });

  it("says it is still waiting, then times out", async () => {
    const onWaiting = vi.fn();
    const status = await waitServerReady({
      dialHost: "127.0.0.1", port: 9, isAlive: () => false, isStopped: () => false,
      timeoutMs: 120, noticeMs: 40, onWaiting, intervalMs: 10,
    });
    expect(status).toBe("timeout");
    expect(onWaiting.mock.calls.length).toBeGreaterThanOrEqual(2);
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
    expect(cliSource).toMatch(/^\s*onBanner: \(text\) => \{ setupBanner = text; \},$/m);
    expect(cliSource).toMatch(/selectMenu\(`Choose Interface \(v\$\{pkg\.version\}\)`, menuItems, 0, subtitle, setupPending \? setupBanner : ""\)/);
    expect(cliSource).toContain('path.join(getDataDir(), "setup-token.json")');
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

  // A top-level binding declared below the startup call is still in its
  // temporal dead zone if startup reaches it synchronously.
  it("declares every top-level binding before it starts the launcher", () => {
    const call = cliSource.search(/^acquireDataDirLock\(/m);
    expect(call).toBeGreaterThan(-1);
    expect(cliSource.slice(call)).not.toMatch(/^(const|let|var|class)\b/m);
  });
});
