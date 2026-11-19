import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";

// The exit recorder makes a restart name its cause. These drive it with a
// stand-in process object, so nothing here can end the test runner.
const require = createRequire(import.meta.url);
const { createDrain, installExitRecorder, installShutdownDrain } = require("../../server-drain.js");

function fakeProcess() {
  const proc = new EventEmitter();
  proc.exited = [];
  // Like process.exit(): emits "exit" from inside the call.
  proc.exit = function exit(code) {
    proc.exited.push(code);
    proc.emit("exit", code ?? 0);
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
});
