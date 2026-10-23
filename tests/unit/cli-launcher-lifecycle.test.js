import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const cliRoot = path.resolve(import.meta.dirname, "../../cli");
const source = fs.readFileSync(process.env.CLI_LAUNCHER_SOURCE || path.join(cliRoot, "cli.js"), "utf8");

async function launch({ args = [], platform = "linux", choice } = {}) {
  const spawns = [], commands = [], kills = [], exits = [], timers = [], stdout = [];
  let menuOpened = false;
  const processMock = Object.assign(new EventEmitter(), {
    argv: ["node", path.join(cliRoot, "cli.js"), "--skip-update", ...args],
    platform, execPath: "/usr/bin/node", pid: 123, env: {},
    stdin: { isTTY: true }, stdout: { isTTY: false, write: (text) => stdout.push(text) },
    stderr: { write() {} }, kill: (pid) => kills.push(pid), exit: (code) => exits.push(code),
  });
  const modules = {
    child_process: {
      spawn: (bin, argv, options) => {
        const child = Object.assign(new EventEmitter(), { pid: 1000 + spawns.length, stderr: new EventEmitter(), unref() {} });
        spawns.push({ bin, argv, options, child });
        // Model stdout transport rather than reading a source string assertion.
        if (options.stdio === "inherit" || options.stdio[1] === "inherit") stdout.push("setup-token-visible");
        return child;
      },
      exec() {}, execSync: (cmd) => {
        commands.push(cmd);
        if (cmd.startsWith("ps ")) return "user 9876 0 0 0 0 ? S 0 0 next-server\n";
        if (cmd.startsWith("lsof")) return "9876";
        return "";
      },
    },
    fs: { existsSync: (file) => file.includes("/app/"), readFileSync: () => "", unlinkSync() {} },
    net: { connect: (_options, ready) => {
      const socket = Object.assign(new EventEmitter(), { destroy() {} });
      queueMicrotask(ready);
      return socket;
    } },
    os: { networkInterfaces: () => ({}), homedir: () => "/fake-user" },
    "./package.json": { name: "10router", version: "0.6.0" },
    "./hooks/sqliteRuntime": { ensureSqliteRuntime() {}, buildEnvWithRuntime: (env) => env },
    "./hooks/trayRuntime": { ensureTrayRuntime() {} },
    "./src/cli/tray/tray": { initTray() {}, killTray() {} },
    "./src/cli/tray/autostart": { enableAutoStart() {} },
    "./src/cli/utils/display": { clearScreen() {} },
    "./src/cli/utils/endpoint": { getEndpoint: async () => ({ tunnelEnabled: false }) },
    "./src/cli/utils/input": { selectMenu: async () => {
      if (!menuOpened && choice === "hide") { menuOpened = true; return 2; }
      return new Promise(() => {});
    } },
  };
  vm.runInNewContext(`(function () {\n${source.replace(/^#![^\n]*\n/, "")}\n})();`, {
    require: (name) => modules[name] || require(name.startsWith(".") ? path.join(cliRoot, name) : name),
    __dirname: cliRoot, __filename: path.join(cliRoot, "cli.js"), process: processMock,
    console: { log() {}, error() {}, warn() {} },
    setTimeout: (fn) => { timers.push(fn); }, clearTimeout() {},
    setImmediate: (fn) => { timers.push(fn); }, setInterval() {}, clearInterval() {}, Buffer, queueMicrotask,
  }, { filename: "cli.js" });
  for (let i = 0; i < 10; i++) await Promise.resolve();
  while (!spawns.length && timers.length) {
    timers.shift()();
    for (let i = 0; i < 10; i++) await Promise.resolve();
  }
  for (let i = 0; i < 20; i++) await Promise.resolve();
  return { spawns, commands, kills, exits, timers, stdout, processMock };
}

describe("launcher process ownership", () => {
  it("starts without scanning or killing unrelated Next servers or port owners", async () => {
    const result = await launch({ args: ["--tray"] });
    expect(result.spawns).toHaveLength(1);
    expect(result.commands).toEqual([]);
    expect(result.kills).toEqual([]);
  });
  it("stops after two retries when a server cannot bind/start", async () => {
    const result = await launch();
    for (let i = 0; i < 3; i++) {
      result.spawns.at(-1).child.emit("close", 1);
      if (i < 2) result.timers.shift()();
    }
    expect(result.spawns).toHaveLength(3);
    expect(result.exits).toContain(1);
    expect(result.commands).toEqual([]);
  });
  it("does not respawn a crashing child after shutdown", async () => {
    const result = await launch();
    result.spawns[0].child.emit("close", 1);
    result.processMock.emit("SIGTERM");
    result.timers.shift()();
    expect(result.spawns).toHaveLength(1);
  });
  it("schedules only one replacement when spawn emits both error and close", async () => {
    const result = await launch();
    result.spawns[0].child.emit("error", new Error("spawn failed"));
    result.spawns[0].child.emit("close", -2);
    expect(result.timers).toHaveLength(1);
    result.timers.shift()();
    expect(result.spawns).toHaveLength(2);
  });
  it("handles server failures in tray-only mode", async () => {
    const result = await launch({ args: ["--tray"] });
    result.spawns[0].child.emit("close", 1);
    expect(result.timers).toHaveLength(1);
  });
});

describe("launcher output and background configuration", () => {
  it("shows the first-run setup token without requiring --log", async () => {
    const result = await launch({ args: ["--tray"] });
    expect(result.stdout).toContain("setup-token-visible");
  });
  it.each(["linux", "win32"])("preserves a local bind and custom port when hidden on %s", async (platform) => {
    const result = await launch({ platform, choice: "hide", args: ["--host", "127.0.0.1", "--port", "20200"] });
    expect(result.spawns).toHaveLength(2);
    const argv = result.spawns[1].argv;
    expect(argv[argv.indexOf("--host") + 1]).toBe("127.0.0.1");
    expect(argv[argv.indexOf("--port") + 1]).toBe("20200");
  });
});
