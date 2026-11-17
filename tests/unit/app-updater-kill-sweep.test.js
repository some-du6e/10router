import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

// A fake process table. `ps -p` and the CIM query return only the rows asked
// for, like the real tools, and ps exits non-zero when one of them is gone.
let table = [];
let listFails = false;
let pidQueriesEmpty = false;
let clock = Date.now();
const two = (n) => String(n).padStart(2, "0");
// Like real ps: [[dd-]hh:]mm:ss, with hh: only once there are hours or days.
function etime(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(s / 86400);
  const hours = Math.floor(s / 3600) % 24;
  const clockPart = `${two(Math.floor(s / 60) % 60)}:${two(s % 60)}`;
  if (days) return `${days}-${two(hours)}:${clockPart}`;
  return hours ? `${two(hours)}:${clockPart}` : clockPart;
}
const execFileSync = vi.fn((cmd, args) => {
  if (listFails) throw Object.assign(new Error("ps: bad -o argument 'uid'"), { stdout: "" });
  if (cmd === "ps") {
    const wanted = args[args.indexOf("-p") + 1].split(",").map(Number);
    const rows = table.filter((row) => wanted.includes(row.pid));
    const out = rows.map((r) => `${String(r.pid).padStart(6)} ${String(r.ppid).padStart(6)} ${String(r.uid).padStart(5)} ${etime(clock - r.created).padStart(11)} ${r.args}`).join("\n") + "\n";
    if (rows.length < wanted.length) throw Object.assign(new Error("exit 1"), { stdout: out });
    return out;
  }
  if (cmd === "powershell.exe") {
    const script = args.at(-1);
    const byPid = [...script.matchAll(/ProcessId=(\d+)/g)].map((m) => Number(m[1]));
    if (byPid.length && pidQueriesEmpty) return "";
    // Created comes back only when the script asks for it the way real PowerShell needs.
    const asksCreated = script.includes("n='Created'") && script.includes(".ToUnixTimeMilliseconds()");
    const rows = (byPid.length
      ? table.filter((row) => byPid.includes(row.pid))
      : table.filter((row) => /^(node|bun)\.exe$/i.test(row.name || "")))
      .map((r) => ({ ProcessId: r.pid, ParentProcessId: r.ppid, CommandLine: r.args, ...(asksCreated ? { Created: r.created } : {}) }));
    return JSON.stringify(rows.length === 1 ? rows[0] : rows);
  }
  return "";
});
vi.mock("child_process", () => ({ execFileSync, spawn: vi.fn() }));
vi.mock("../../src/lib/tunnel/cloudflare/pid.js", () => ({ loadPid: () => null }));

const { collectAppPids, killAppProcesses } = await import("../../src/lib/appUpdater.js");
const {
  busyInstallPids, busyInstallMessage, rememberOwnCloudflared, runtimeUpdaterPath,
  LAUNCHER_PID_ENV, LAUNCHER_STATE_ENV, UPDATER_PID_ENV,
} = await import("../../src/lib/appProcesses.js");

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(import.meta.dirname, "../..");

const NOW = 1_800_000_000_000;
const SERVER_START = NOW - 60_000;
const ME = 1000;
const OTHER_USER = 1001;
const PKG = "/usr/lib/node_modules/10router";
const DATA = "/home/me/.9router";
const UPDATER = `${DATA}/runtime/updater/updater.js`;
const SELF = 5000;
const LAUNCHER = 4000;

const OURS = [
  { pid: LAUNCHER, ppid: 1, uid: ME, created: NOW - 120_000, args: `/usr/bin/node --dns-result-order=ipv4first ${PKG}/cli.js --tray --skip-update` },
  { pid: SELF, ppid: LAUNCHER, uid: ME, created: SERVER_START, args: "next-server (v16.0.0)" },
  { pid: 4001, ppid: LAUNCHER, uid: ME, created: NOW - 50_000, args: "/home/me/.cache/node-systray/2.1.4/tray_linux_release" },
  { pid: 5001, ppid: SELF, uid: ME, created: NOW - 30_000, args: `${DATA}/bin/cloudflared tunnel run --dns-resolver-addrs 1.1.1.1:53 --token t` },
  { pid: 3900, ppid: 1, uid: ME, created: NOW - 600_000, args: `/usr/bin/node ${UPDATER}` },
];
const NOT_OURS = [
  { pid: 6001, ppid: 777, uid: ME, created: NOW - 10_000, args: "node server.js" },
  { pid: 6002, ppid: 777, uid: ME, created: NOW - 10_000, args: "node ." },
  { pid: 6003, ppid: 777, uid: ME, created: NOW - 900_000, args: "next-server (v16.0.0)" },
  { pid: 7000, ppid: 1, uid: ME, created: NOW - 900_000, args: "/usr/bin/node --dns-result-order=ipv4first /home/me/dev/10router/cli/cli.js" },
  { pid: 7001, ppid: 7005, uid: ME, created: NOW - 900_000, args: `${DATA}/bin/cloudflared tunnel --url http://127.0.0.1:20200 --no-autoupdate` },
  { pid: 7002, ppid: 1, uid: ME, created: NOW - 900_000, args: "/usr/bin/node /srv/other-data/runtime/updater/updater.js" },
  { pid: 7003, ppid: 1, uid: ME, created: NOW - 5_000, args: `/usr/bin/node ${UPDATER}` },
  { pid: 8001, ppid: LAUNCHER, uid: OTHER_USER, created: NOW - 50_000, args: "/home/other/.cache/node-systray/2.1.4/tray_linux_release" },
];

let stateDir;
function launcherState(children, launcherPid = LAUNCHER) {
  const file = path.join(stateDir, `${launcherPid}.json`);
  fs.writeFileSync(file, JSON.stringify({ launcherPid, children }));
  return file;
}
const ownLauncherEnv = (children) => ({
  [LAUNCHER_PID_ENV]: String(LAUNCHER),
  ...(children ? { [LAUNCHER_STATE_ENV]: launcherState(children) } : {}),
});

function ctx({ env = {}, cloudflaredPid = null, parent = LAUNCHER, platform = "linux", ...rest } = {}) {
  return {
    env: { PORT: "20128", ...env }, self: SELF, parent, platform, cloudflaredPid,
    uid: platform === "win32" ? undefined : ME, now: NOW, serverStart: SERVER_START,
    installRoot: PKG, updaterPath: UPDATER, ...rest,
  };
}
const collect = (options) => collectAppPids(ctx(options));

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "10router-launchers-"));
  table = [...OURS, ...NOT_OURS];
  listFails = false;
  pidQueriesEmpty = false;
  clock = NOW;
  execFileSync.mockClear();
});
afterEach(() => {
  fs.rmSync(stateDir, { recursive: true, force: true });
});

describe("collectAppPids", () => {
  it("stops what this install recorded: tray, cloudflared, updater, then the launcher", () => {
    const env = { ...ownLauncherEnv({ tray: 4001 }), [UPDATER_PID_ENV]: "3900" };

    expect(collect({ env, cloudflaredPid: 5001 })).toEqual([4001, 5001, 3900, LAUNCHER]);
    // Only the recorded PIDs are looked up; nothing lists every process.
    expect(execFileSync).toHaveBeenCalledTimes(1);
    const [cmd, args, options] = execFileSync.mock.calls[0];
    expect(cmd).toBe("ps");
    // This server's own row is read too, for its start time.
    expect(args).toEqual(["-o", "pid=,ppid=,uid=,etime=,args=", "-p", `4001,5001,3900,${LAUNCHER},${SELF}`]);
    expect(options.maxBuffer).toBeGreaterThan(1024 * 1024);
  });

  it("never kills a user's own programs, even when a stale record points at them", () => {
    // PIDs recycled since they were recorded.
    const env = { ...ownLauncherEnv({ tray: 6001 }), [UPDATER_PID_ENV]: "6003" };
    expect(collect({ env, cloudflaredPid: 6002 })).toEqual([LAUNCHER]);
  });

  it("leaves another install's cloudflared and updater alone", () => {
    // The cloudflared PID file in a shared DATA_DIR names another install's tunnel.
    expect(collect({ cloudflaredPid: 7001 })).toEqual([]);
    // A recorded updater PID now running another data dir's updater.
    expect(collect({ env: { [UPDATER_PID_ENV]: "7002" } })).toEqual([]);
    // Same script path, but started after this server: not the one that relaunched it.
    expect(collect({ env: { [UPDATER_PID_ENV]: "7003" } })).toEqual([]);
  });

  it("stops a quick tunnel for this port that a previous server left behind", () => {
    table.push({ pid: 5101, ppid: 1, uid: ME, created: NOW - 900_000, args: `${DATA}/bin/cloudflared tunnel --url http://127.0.0.1:20128 --config /tmp/c/config.yml` });
    expect(collect({ cloudflaredPid: 5101 })).toEqual([5101]);
  });

  it("trusts the launcher only while it is still this server's parent", () => {
    const env = ownLauncherEnv({ tray: 4001 });
    // Reparented (launcher gone) or the variable was inherited from elsewhere.
    expect(collect({ env, parent: 1 })).toEqual([]);
    expect(collect({ env, parent: 7000 })).toEqual([]);
  });

  it("ignores a state file written for a different launcher", () => {
    const file = launcherState({ tray: 4001 }, 7000);
    expect(collect({ env: { [LAUNCHER_PID_ENV]: String(LAUNCHER), [LAUNCHER_STATE_ENV]: file } })).toEqual([LAUNCHER]);
  });

  it("skips another user's process", () => {
    expect(collect({ env: ownLauncherEnv({ tray: 8001 }) })).toEqual([LAUNCHER]);
  });

  it("works when the CLI and updater run under Bun", () => {
    table = [
      { pid: LAUNCHER, ppid: 1, uid: ME, created: NOW - 120_000, args: `/home/me/.bun/bin/bun ${PKG}/cli.js --tray` },
      { pid: 3900, ppid: 1, uid: ME, created: NOW - 600_000, args: `/home/me/.bun/bin/bun ${UPDATER}` },
    ];
    const env = { [LAUNCHER_PID_ENV]: String(LAUNCHER), [UPDATER_PID_ENV]: "3900" };
    expect(collect({ env })).toEqual([3900, LAUNCHER]);
  });

  it("reads elapsed times over a day", () => {
    clock = NOW + 3 * 86_400_000;
    expect(collect({ env: { [UPDATER_PID_ENV]: "3900" }, now: clock, serverStart: clock - 60_000 })).toEqual([3900]);
  });

  it("kills nothing when the process table can't be read (BusyBox ps)", () => {
    listFails = true;
    const env = { ...ownLauncherEnv({ tray: 4001 }), [UPDATER_PID_ENV]: "3900" };
    expect(collect({ env, cloudflaredPid: 5001 })).toEqual([]);
  });

  it("doesn't read the process table when nothing was recorded", () => {
    expect(collect()).toEqual([]);
    expect(execFileSync).not.toHaveBeenCalled();
  });
});

describe("collectAppPids on Windows", () => {
  const ROOT = "C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\10router";
  const WIN_DATA = "C:\\Users\\me\\AppData\\Roaming\\9router";
  // What npm's cmd shim actually runs: "%dp0%\node_modules\…" leaves a doubled backslash.
  const launcherRow = (over = {}) => ({
    pid: LAUNCHER, ppid: 900, created: NOW - 120_000, name: "node.exe",
    args: '"C:\\Program Files\\nodejs\\node.exe"  "C:\\Users\\me\\AppData\\Roaming\\npm\\\\node_modules\\10router\\cli.js" --tray', ...over,
  });
  const winCtx = (options) => ({ platform: "win32", installRoot: ROOT, updaterPath: `${WIN_DATA}\\runtime\\updater\\updater.js`, ...options });

  beforeEach(() => {
    table = [
      launcherRow(),
      { pid: SELF, ppid: LAUNCHER, created: SERVER_START, name: "node.exe", args: `"C:\\Program Files\\nodejs\\node.exe" "${ROOT}\\app\\custom-server.js"` },
      { pid: 4001, ppid: LAUNCHER, created: NOW - 50_000, args: `powershell.exe -NoProfile -File "${ROOT}\\src\\cli\\tray\\tray.ps1"` },
      { pid: 5001, ppid: SELF, created: NOW - 30_000, args: `"${WIN_DATA}\\bin\\cloudflared.exe" tunnel run --token t` },
      { pid: 7001, ppid: 7005, created: NOW - 900_000, args: `"${WIN_DATA}\\bin\\cloudflared.exe" tunnel --url http://127.0.0.1:20200` },
    ];
  });

  it("stops the recorded tray, cloudflared and launcher", () => {
    const env = ownLauncherEnv({ tray: 4001 });
    expect(collect(winCtx({ env, cloudflaredPid: 5001 }))).toEqual([4001, 5001, LAUNCHER]);
    expect(collect(winCtx({ cloudflaredPid: 7001 }))).toEqual([]);
    const [cmd, args, options] = execFileSync.mock.calls[0];
    expect(cmd).toBe("powershell.exe");
    expect(args.at(-1)).toContain(`ProcessId=4001 OR ProcessId=5001 OR ProcessId=4000 OR ProcessId=${SELF}`);
    expect(args.at(-1)).toContain("n='Created'");
    expect(args.at(-1)).toContain(".ToUnixTimeMilliseconds()");
    expect(options.maxBuffer).toBeGreaterThan(1024 * 1024);
  });

  it("refuses a launcher whose start time is unknown", () => {
    table[0] = launcherRow({ created: null });
    expect(collect(winCtx({ env: ownLauncherEnv({ tray: 4001 }) }))).toEqual([]);
  });

  it("times the server by its own CreationDate, not by Date.now() - uptime", () => {
    // The wall clock stepped back: by Date.now() - uptime the server "started"
    // before its launcher. Its CreationDate, from the same query, says otherwise.
    table[0] = launcherRow({ created: SERVER_START + 5_000 });
    table[1] = { ...table[1], created: SERVER_START + 10_000 };
    table[3] = { ...table[3], created: SERVER_START + 7_000 };
    const env = ownLauncherEnv({ tray: 4001 });
    expect(collect(winCtx({ env, cloudflaredPid: 5001 }))).toEqual([4001, LAUNCHER]);
    table[3] = { ...table[3], created: SERVER_START + 20_000 };
    expect(collect(winCtx({ env, cloudflaredPid: 5001 }))).toEqual([4001, 5001, LAUNCHER]);
  });

  it("matches a launcher started through a junction or symlinked npm prefix", () => {
    // nvm-windows: the shim runs C:\nvm\nodejs\… while this server sees the real path.
    table[0] = launcherRow({ args: '"C:\\nvm\\nodejs\\node.exe" "C:\\nvm\\nodejs\\node_modules\\10router\\cli.js" --tray' });
    const env = ownLauncherEnv({ tray: 4001 });
    const realpath = (p) => {
      if (p.toLowerCase().startsWith("c:\\nvm\\nodejs\\node_modules\\10router")) return ROOT + p.slice("C:\\nvm\\nodejs\\node_modules\\10router".length);
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    };
    expect(collect(winCtx({ env, realpath }))).toEqual([4001, LAUNCHER]);
    expect(collect(winCtx({ env }))).toEqual([]);
  });

  it("refuses a launcher PID that now belongs to another program", () => {
    // The launcher died and Windows handed its PID to a browser; the server's
    // parent PID still says 4000.
    const env = ownLauncherEnv({ tray: 4001 });
    table[0] = launcherRow({ created: NOW - 1_000, args: '"C:\\Program Files\\Google\\Chrome\\chrome.exe" --type=renderer' });
    expect(collect(winCtx({ env }))).toEqual([]);
    // Another install's cli.js under that PID.
    table[0] = launcherRow({ args: '"C:\\Program Files\\nodejs\\node.exe" "C:\\dev\\10router\\cli\\cli.js"' });
    expect(collect(winCtx({ env }))).toEqual([]);
    // This install's cli.js, but started after this server: a newer launcher.
    table[0] = launcherRow({ created: NOW - 1_000 });
    expect(collect(winCtx({ env }))).toEqual([]);
  });

  it("refuses a recorded tray or cloudflared PID that was reused", () => {
    // Created before the launcher: it was the child of an earlier owner of PID 4000.
    table[2] = { pid: 4001, ppid: LAUNCHER, created: NOW - 900_000, args: '"C:\\Program Files\\Microsoft\\Edge\\msedge.exe"' };
    // Created before this server: not the cloudflared it spawned.
    table[3] = { ...table[3], created: NOW - 900_000 };
    expect(collect(winCtx({ env: ownLauncherEnv({ tray: 4001 }), cloudflaredPid: 5001 }))).toEqual([LAUNCHER]);
  });

  it("kills nothing when PowerShell can't list processes", () => {
    listFails = true;
    expect(collect(winCtx({ env: ownLauncherEnv({ tray: 4001 }), cloudflaredPid: 5001 }))).toEqual([]);
  });
});

describe("busyInstallPids", () => {
  const ROOT = "C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\10router";
  const node = '"C:\\Program Files\\nodejs\\node.exe"';

  it("finds another running copy of this install on Windows", () => {
    table = [
      { pid: LAUNCHER, ppid: 900, created: NOW - 120_000, name: "node.exe", args: `${node} "${ROOT}\\cli.js" --tray` },
      { pid: SELF, ppid: LAUNCHER, created: SERVER_START, name: "node.exe", args: `${node} "${ROOT}\\app\\custom-server.js"` },
      { pid: 7100, ppid: 900, created: NOW - 900_000, name: "node.exe", args: `${node} --dns-result-order=ipv4first "${ROOT}\\cli.js"` },
      { pid: 7101, ppid: 7100, created: NOW - 900_000, name: "node.exe", args: `${node} --max-old-space-size=6144 ${ROOT.toLowerCase()}\\app\\custom-server.js` },
      { pid: 7200, ppid: 900, created: NOW - 900_000, name: "node.exe", args: `${node} "C:\\dev\\10router\\cli\\cli.js"` },
      { pid: 7300, ppid: 900, created: NOW - 900_000, name: "node.exe", args: `${node} server.js` },
    ];
    const options = ctx({ platform: "win32", installRoot: ROOT, env: { [LAUNCHER_PID_ENV]: String(LAUNCHER) } });

    expect(busyInstallPids(options)).toEqual([7100, 7101]);
    expect(busyInstallMessage([7100, 7101])).toBe("Another 10router from this install is running (PID 7100, 7101); stop it, then update.");
    // Only the launcher that is this server's parent is left out.
    expect(busyInstallPids({ ...options, parent: 1 })).toEqual([LAUNCHER, 7100, 7101]);

    // The launcher stays excluded when it can't be verified: a by-PID listing
    // that came back empty (cold PowerShell timing out), or a start time that a
    // clock step put after the server's.
    pidQueriesEmpty = true;
    table[0] = { ...table[0], created: NOW };
    expect(busyInstallPids(options)).toEqual([7100, 7101]);
  });

  it("resolves links only for tokens named like a target, each target once", () => {
    // An unrelated script on an offline mapped drive must not stall the check.
    table = [
      { pid: 7400, ppid: 900, created: NOW - 900_000, name: "node.exe", args: `${node} "Z:\\tools\\x.js" --watch` },
      { pid: 7401, ppid: 900, created: NOW - 900_000, name: "node.exe", args: `${node} "\\\\nas\\share\\y.js"` },
      { pid: 7402, ppid: 900, created: NOW - 900_000, name: "bun.exe", args: '"C:\\Users\\me\\.bun\\bin\\bun.exe" "Z:\\tools\\cli.js"' },
    ];
    const realpath = vi.fn(() => { throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); });

    expect(busyInstallPids(ctx({ platform: "win32", installRoot: ROOT, realpath }))).toEqual([]);

    const resolved = realpath.mock.calls.map(([p]) => p);
    // The three targets, once each, then only the token named cli.js.
    expect(resolved).toEqual([
      `${ROOT}\\cli.js`, `${ROOT}\\app\\custom-server.js`, `${ROOT}\\app\\server.js`,
      "Z:\\tools\\cli.js",
    ]);
  });

  it("is empty off Windows and when the list can't be read", () => {
    expect(busyInstallPids(ctx({ platform: "linux" }))).toEqual([]);
    listFails = true;
    expect(busyInstallPids(ctx({ platform: "win32", installRoot: ROOT }))).toEqual([]);
  });
});

describe("records written by the launcher and updater", () => {
  it("round-trips the launcher's state file through collectAppPids", () => {
    const previous = process.env.DATA_DIR;
    process.env.DATA_DIR = stateDir;
    try {
      const { recordChild, launcherEnv } = require("../../cli/src/cli/utils/launcherState.js");
      recordChild("tray", 4001);
      const env = launcherEnv();
      expect(Object.keys(env).sort()).toEqual([LAUNCHER_PID_ENV, LAUNCHER_STATE_ENV].sort());
      table = [
        { pid: process.pid, ppid: 1, uid: ME, created: NOW - 120_000, args: `/usr/bin/node ${PKG}/cli.js` },
        { pid: 4001, ppid: process.pid, uid: ME, created: NOW - 50_000, args: "/home/me/.cache/node-systray/2.1.4/tray_linux_release" },
      ];
      expect(collect({ env, parent: process.pid })).toEqual([4001, process.pid]);
    } finally {
      if (previous === undefined) delete process.env.DATA_DIR;
      else process.env.DATA_DIR = previous;
    }
  });

  it("the updater passes its PID under the name the server reads", () => {
    const updater = fs.readFileSync(path.join(repoRoot, "src/lib/updater/updater.js"), "utf8");
    expect(updater).toContain(`${UPDATER_PID_ENV}: String(process.pid)`);
  });
});

describe("killAppProcesses", () => {
  const uid = process.getuid?.();
  let kill;
  beforeEach(() => {
    clock = Date.now();
    kill = vi.spyOn(process, "kill").mockImplementation(() => true);
  });
  afterEach(() => {
    kill.mockRestore();
    vi.unstubAllEnvs();
  });

  it.skipIf(uid === undefined)("sends SIGKILL to the recorded PIDs only", async () => {
    const processStart = Date.now() - process.uptime() * 1000;
    table = [{ pid: 3900, ppid: 1, uid, created: processStart - 600_000, args: `/usr/bin/node ${runtimeUpdaterPath()}` }, ...NOT_OURS];
    vi.stubEnv(UPDATER_PID_ENV, "3900");

    await killAppProcesses();

    expect(kill.mock.calls).toEqual([[3900, "SIGKILL"]]);
  });

  it.skipIf(uid === undefined)("removes the state file of a launcher it killed", async () => {
    const launcher = process.ppid;
    const file = launcherState({}, launcher);
    table = [{ pid: launcher, ppid: 1, uid, created: Date.now() - 3_600_000, args: `/usr/bin/node ${PKG}/cli.js` }];
    vi.stubEnv(LAUNCHER_PID_ENV, String(launcher));
    vi.stubEnv(LAUNCHER_STATE_ENV, file);

    await killAppProcesses();

    expect(kill.mock.calls).toEqual([[launcher, "SIGKILL"]]);
    expect(fs.existsSync(file)).toBe(false);
  });

  it("stops this server's own cloudflared by its handle even when ps can't be read", async () => {
    listFails = true;
    const child = Object.assign(new EventEmitter(), { pid: 5001 });
    const stop = vi.fn();
    rememberOwnCloudflared(child, stop);

    await killAppProcesses();

    expect(stop).toHaveBeenCalledTimes(1);
    expect(kill).not.toHaveBeenCalled();
  });
});
