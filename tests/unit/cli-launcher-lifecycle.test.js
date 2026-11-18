import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);
const { superviseServer } = require("../../cli/src/cli/utils/serverSupervisor.js");
const { getBackgroundArgs, serverStdio } = require("../../cli/src/cli/utils/launchArgs.js");

const cliSource = fs.readFileSync(path.resolve(import.meta.dirname, "../../cli/cli.js"), "utf8");

function harness({ maxRestarts = 2, resetMs = 30000 } = {}) {
  const children = [];
  const timers = [];
  let clock = 0;
  let shuttingDown = false;
  const onExit = vi.fn();
  const onGiveUp = vi.fn();
  const onRestart = vi.fn();
  const supervisor = superviseServer({
    spawn: () => {
      const child = new EventEmitter();
      child.pid = 1000 + children.length;
      children.push(child);
      return child;
    },
    isShuttingDown: () => shuttingDown,
    onExit,
    onGiveUp,
    onRestart,
    maxRestarts,
    resetMs,
    now: () => clock,
    schedule: (fn, delay) => timers.push({ fn, delay }),
  });
  supervisor.start();
  return {
    supervisor, children, timers, onExit, onGiveUp, onRestart,
    last: () => children.at(-1),
    runTimers: () => { while (timers.length) timers.shift().fn(); },
    advance: (ms) => { clock += ms; },
    shutdown: () => { shuttingDown = true; },
  };
}

describe("launcher server supervisor", () => {
  it("gives up after two restarts when the server can't bind", () => {
    const h = harness();
    for (let i = 0; i < 3; i++) {
      h.last().emit("close", 1);
      h.runTimers();
    }
    expect(h.children).toHaveLength(3);
    expect(h.onRestart).toHaveBeenCalledTimes(2);
    expect(h.onGiveUp).toHaveBeenCalledTimes(1);
    expect(h.onGiveUp).toHaveBeenCalledWith({ code: 1, error: undefined });
  });

  it("does not respawn a crashed child once shutdown has begun", () => {
    const h = harness();
    h.last().emit("close", 1);
    expect(h.timers).toHaveLength(1);
    h.shutdown();
    h.runTimers();
    expect(h.children).toHaveLength(1);
    expect(h.onGiveUp).not.toHaveBeenCalled();
  });

  it("schedules one replacement when a failed spawn emits both error and close", () => {
    const h = harness();
    const error = new Error("spawn ENOENT");
    h.last().emit("error", error);
    h.last().emit("close", -2);
    expect(h.timers).toHaveLength(1);
    expect(h.onRestart).toHaveBeenCalledWith(expect.objectContaining({ error, attempt: 1 }));
    h.runTimers();
    expect(h.children).toHaveLength(2);
  });

  it("backs off 1s then 2s between restarts", () => {
    const h = harness();
    h.last().emit("close", 1);
    expect(h.timers[0].delay).toBe(1000);
    h.runTimers();
    h.last().emit("close", 1);
    expect(h.timers[0].delay).toBe(2000);
  });

  it("resets the restart budget after a run that stayed up", () => {
    const h = harness();
    h.last().emit("close", 1);
    h.runTimers();
    h.last().emit("close", 1);
    h.runTimers();
    h.advance(30000);
    h.last().emit("close", 1);
    expect(h.onGiveUp).not.toHaveBeenCalled();
    expect(h.onRestart).toHaveBeenLastCalledWith(expect.objectContaining({ attempt: 1 }));
  });

  it("exits with the server on a clean exit or during shutdown", () => {
    const clean = harness();
    clean.last().emit("close", 0);
    expect(clean.onExit).toHaveBeenCalledWith(0);
    expect(clean.timers).toHaveLength(0);

    const stopping = harness();
    stopping.shutdown();
    stopping.last().emit("close", null);
    expect(stopping.onExit).toHaveBeenCalledWith(0);
    expect(stopping.timers).toHaveLength(0);
  });

  it("tracks the current child for cleanup", () => {
    const h = harness();
    expect(h.supervisor.current()).toBe(h.children[0]);
    h.last().emit("close", 1);
    h.runTimers();
    expect(h.supervisor.current()).toBe(h.children[1]);
  });
});

describe("launcher process ownership", () => {
  // A port owner or a Next.js server found by name is not ours to kill.
  it("has no process-list or port-owner kill sweep", () => {
    for (const probe of ["lsof", "netstat", "ps aux", "ps -eo", "taskkill", "kill -9", "Get-WmiObject", "next-server"]) {
      expect(cliSource, probe).not.toContain(probe);
    }
  });

  // startServer now runs synchronously, so a top-level const declared below
  // the call is still in its temporal dead zone when startServer reads it.
  it("declares every top-level binding before it starts the server", () => {
    const call = cliSource.search(/^startServer\(updatePromise\);$/m);
    expect(call).toBeGreaterThan(-1);
    expect(cliSource.slice(call)).not.toMatch(/^(const|let|var) /m);
  });

  it("supervises the server before the tray-only branch returns", () => {
    const start = cliSource.indexOf("supervisor.start()");
    const trayBranch = cliSource.indexOf("if (trayMode) {", cliSource.indexOf("function startServer"));
    expect(start).toBeGreaterThan(-1);
    expect(trayBranch).toBeGreaterThan(start);
  });
});

describe("launcher output and background relaunch", () => {
  it("keeps server stdout visible without --log so the setup token shows", () => {
    expect(serverStdio(false)).toEqual(["ignore", "inherit", "pipe"]);
    expect(serverStdio(true)).toBe("inherit");
  });

  it("carries a local bind and custom port into the hidden tray relaunch", () => {
    const args = getBackgroundArgs({ host: "127.0.0.1", port: 20200 });
    expect(args).toEqual(["--tray", "--skip-update", "--port", "20200", "--host", "127.0.0.1"]);
    expect(cliSource).toMatch(/getBackgroundArgs\(\{\s*port,\s*host\s*\}\)/);
  });

  it("defaults to the standard bind when nothing was chosen", () => {
    expect(getBackgroundArgs()).toEqual(["--tray", "--skip-update", "--port", "20128", "--host", "0.0.0.0"]);
  });
});
