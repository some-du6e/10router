import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";

// The exit recorder makes a restart name its cause. These drive it with a
// stand-in process object, so nothing here can end the test runner.
const require = createRequire(import.meta.url);
const { createDrain, installExitRecorder, installShutdownDrain, logSync, writeLineSync } = require("../../server-drain.js");

function fakeProcess() {
  const proc = new EventEmitter();
  proc.exited = [];
  // Like process.exit(): emits "exit" once from inside the call, not again
  // when an "exit" listener calls it.
  proc.exit = function exit(code) {
    proc.exited.push(code);
    if (!proc._exiting) {
      proc._exiting = true;
      proc.emit("exit", code ?? 0);
    }
  };
  proc.uptime = () => 42;
  proc.memoryUsage = () => ({ rss: 300 * 1048576, heapUsed: 120 * 1048576 });
  proc.versions = {};
  proc.env = {};
  return proc;
}

describe("installExitRecorder", () => {
  it("logs the code, uptime, open requests, memory and the caller of process.exit()", () => {
    const proc = fakeProcess();
    const log = vi.fn();
    installExitRecorder(proc, { log, inflight: () => 3 });

    function shutdownRouteHandler() {
      proc.exit(0);
    }
    shutdownRouteHandler();

    expect(log).toHaveBeenCalledTimes(1);
    const [line] = log.mock.calls[0];
    expect(line).toMatch(/^\[Exit\] exiting with code 0 after 42s with 3 request\(s\) open, rss 300 MB, heap 120 MB\n  process\.exit\(\) called from:\n/);
    // The first caller frame is the code that asked to exit.
    expect(line.split("\n")[2]).toContain("shutdownRouteHandler");
  });

  it("says the event loop ran empty when no process.exit() call is on the stack", () => {
    const proc = fakeProcess();
    const log = vi.fn();
    installExitRecorder(proc, { log });

    // Node emits "exit" itself once nothing is left to run.
    proc.emit("exit", 0);

    expect(log.mock.calls[0][0]).toBe(
      "[Exit] exiting with code 0 after 42s with 0 request(s) open, rss 300 MB, heap 120 MB\n" +
        "  the event loop ran empty: nothing was listening or pending"
    );
  });

  it("names an uncaught exception, which Node ends the process on without process.exit()", () => {
    const proc = fakeProcess();
    const log = vi.fn();
    installExitRecorder(proc, { log });
    // Node's own frame when nothing handles an exception.
    proc._fatalException = function _fatalException() { proc.emit("exit", 1); };

    proc._fatalException();

    expect(log.mock.calls[0][0]).toBe(
      "[Exit] exiting with code 1 after 42s with 0 request(s) open, rss 300 MB, heap 120 MB\n" +
        "  an uncaught exception ended the process (Node prints it above)"
    );
  });

  it("names an unhandled rejection", () => {
    const proc = fakeProcess();
    const log = vi.fn();
    installExitRecorder(proc, { log });
    proc._fatalException = function _fatalException() { proc.emit("exit", 1); };
    function processPromiseRejections() { proc._fatalException(); }

    processPromiseRejections();

    expect(log.mock.calls[0][0]).toContain("\n  an unhandled promise rejection ended the process");
  });

  it("doesn't call a nonzero exit with no process.exit() frame an empty event loop", () => {
    const proc = fakeProcess();
    const log = vi.fn();
    installExitRecorder(proc, { log });

    proc.emit("exit", 7);

    expect(log.mock.calls[0][0]).toContain("\n  no process.exit() call: an uncaught exception or a fatal error in Node");
    expect(log.mock.calls[0][0]).not.toContain("event loop");
  });

  it("still logs the exit when memory use or the open count can't be read", () => {
    const proc = fakeProcess();
    proc.memoryUsage = () => { throw new Error("EMFILE"); };
    const log = vi.fn();
    installExitRecorder(proc, { log, inflight: () => { throw new Error("gone"); } });

    proc.emit("exit", 1);

    expect(log.mock.calls[0][0]).toMatch(/^\[Exit\] exiting with code 1 after 42s with \? request\(s\) open\n/);
  });

  it("leaves Error.stackTraceLimit as it was", () => {
    const proc = fakeProcess();
    installExitRecorder(proc, { log: () => {} });
    const before = Error.stackTraceLimit;

    proc.exit(0);

    expect(Error.stackTraceLimit).toBe(before);
  });

  it("names the drain as the caller after a drained shutdown", async () => {
    const proc = fakeProcess();
    const log = vi.fn();
    const drain = createDrain({ timeoutMs: 1000, log, flushMs: 0 });
    // The order custom-server.js uses.
    expect(installShutdownDrain(proc, drain)).toBe(true);
    installExitRecorder(proc, { log, inflight: () => drain.inflight });
    // What the database adapters register: run after the drain, with exit held.
    proc.once("SIGTERM", () => proc.exit(0));

    proc.emit("SIGTERM");
    await vi.waitFor(() => expect(proc.exited).toEqual([0]));

    const lines = log.mock.calls.map(([line]) => line);
    expect(lines.some((line) => line.startsWith("[Shutdown] SIGTERM: draining"))).toBe(true);
    const exitLines = lines.filter((line) => line.startsWith("[Exit]"));
    // One exit, from the drain: the adapter's own process.exit(0) was held off.
    expect(exitLines).toHaveLength(1);
    expect(exitLines[0]).toMatch(/^\[Exit\] exiting with code 0 after 42s with 0 request\(s\) open/);
    expect(exitLines[0]).toContain("process.exit() called from:");
    // The first caller frame is the drain's own exit.
    expect(exitLines[0].split("\n")[2]).toMatch(/[/\\]server-drain\.js:/);
  });

  it("runs before an earlier \"exit\" listener that calls process.exit(), which would skip the rest", () => {
    const proc = fakeProcess();
    const log = vi.fn();
    proc.on("exit", () => proc.exit(3));
    installExitRecorder(proc, { log });

    function updaterHandoff() {
      proc.exit(0);
    }
    updaterHandoff();

    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toMatch(/^\[Exit\] exiting with code 0 [^\n]*\n {2}process\.exit\(\) called from:\n/);
    expect(log.mock.calls[0][0].split("\n")[2]).toContain("updaterHandoff");
  });

  it("never throws out of the exit, even when logging fails", () => {
    const proc = fakeProcess();
    installExitRecorder(proc, { log: () => { throw new Error("EPIPE"); } });

    expect(() => proc.exit(0)).not.toThrow();
    expect(proc.exited).toEqual([0]);
  });
});

describe("writeLineSync", () => {
  const eagain = () => Object.assign(new Error("EAGAIN: resource temporarily unavailable, write"), { code: "EAGAIN" });

  it("writes to stderr only, waiting out a full pipe and finishing a partial write", () => {
    const got = [];
    let calls = 0;
    const writeSync = vi.fn((fd, buf) => {
      calls++;
      if (calls === 1) throw eagain();
      // Half now, the rest on the next call.
      const n = calls === 2 ? Math.ceil(buf.length / 2) : buf.length;
      got.push([fd, buf.subarray(0, n).toString()]);
      return n;
    });
    const sleep = vi.fn();

    expect(writeLineSync("[Exit] exiting with code 0", { writeSync, sleep, now: () => 0 })).toBe(true);

    expect(writeSync.mock.calls.every(([fd]) => fd === 2)).toBe(true);
    expect(got.map(([, text]) => text).join("")).toBe("[Exit] exiting with code 0\n");
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("gives up once the pipe stays full for its whole budget", () => {
    let clock = 0;
    const writeSync = vi.fn(() => { throw eagain(); });

    const ok = writeLineSync("[Shutdown] SIGTERM", { writeSync, budgetMs: 50, now: () => clock, sleep: (ms) => { clock += ms; } });

    expect(ok).toBe(false);
    expect(clock).toBeGreaterThanOrEqual(50);
    expect(clock).toBeLessThan(60);
    expect(writeSync.mock.calls.every(([fd]) => fd === 2)).toBe(true);
  });

  it("gives up at once on an error other than EAGAIN", () => {
    const writeSync = vi.fn(() => { throw Object.assign(new Error("EPIPE"), { code: "EPIPE" }); });
    const sleep = vi.fn();

    expect(writeLineSync("x", { writeSync, sleep, now: () => 0 })).toBe(false);
    expect(writeSync).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});

describe("logSync", () => {
  it("queues the line through console.log only when the direct write failed", () => {
    const fallback = vi.fn();

    logSync("[Exit] a", { write: () => true, fallback });
    expect(fallback).not.toHaveBeenCalled();

    logSync("[Exit] b", { write: () => false, fallback });
    expect(fallback).toHaveBeenCalledWith("[Exit] b");
  });
});

describe("drain start", () => {
  it("starts the duplicate-signal window after the SIGTERM line is written, so a slow write can't turn npm's repeat into an exit", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      const exit = vi.fn();
      // The first line takes 2 s to get out (a full pipe).
      const log = vi.fn((line) => { if (line.includes("draining")) vi.setSystemTime(Date.now() + 2000); });
      const drain = createDrain({ timeoutMs: 60000, exit, log });

      drain.start("SIGTERM");
      vi.setSystemTime(Date.now() + 100);
      drain.start("SIGTERM");

      expect(exit).not.toHaveBeenCalledWith(1, expect.anything());
      expect(log.mock.calls.at(-1)[0]).toContain("already draining, ignored");
    } finally {
      vi.useRealTimers();
    }
  });
});
