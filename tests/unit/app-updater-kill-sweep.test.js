import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// A fake process table. `ps -p` and the CIM query return only the rows asked
// for, like the real tools, and ps exits non-zero when one of them is gone.
let table = [];
let listFails = false;
const execFileSync = vi.fn((cmd, args, options) => {
  if (listFails) throw Object.assign(new Error("ps: bad -o argument 'uid'"), { stdout: "" });
  if (cmd === "ps") {
    const wanted = args[args.indexOf("-p") + 1].split(",").map(Number);
    const rows = table.filter((row) => wanted.includes(row.pid));
    const out = rows.map((r) => `${String(r.pid).padStart(6)} ${String(r.ppid).padStart(6)} ${String(r.uid).padStart(5)} ${r.args}`).join("\n") + "\n";
    if (rows.length < wanted.length) throw Object.assign(new Error("exit 1"), { stdout: out });
    return out;
  }
  if (cmd === "powershell.exe") {
    const wanted = [...args.at(-1).matchAll(/ProcessId=(\d+)/g)].map((m) => Number(m[1]));
    const rows = table.filter((row) => wanted.includes(row.pid))
      .map((r) => ({ ProcessId: r.pid, ParentProcessId: r.ppid, CommandLine: r.args }));
    return JSON.stringify(rows.length === 1 ? rows[0] : rows);
  }
  return "";
});
vi.mock("child_process", () => ({ execFileSync, spawn: vi.fn() }));
vi.mock("../../src/lib/tunnel/cloudflare/pid.js", () => ({ loadPid: () => null }));

const { collectAppPids, killAppProcesses } = await import("../../src/lib/appUpdater.js");

const ME = 1000;
const OTHER_USER = 1001;
const PKG = "/usr/lib/node_modules/10router";
const DATA = "/home/me/.9router";
const SELF = 5000;
const LAUNCHER = 4000;

const OURS = [
  { pid: LAUNCHER, ppid: 1, uid: ME, args: `/usr/bin/node --dns-result-order=ipv4first ${PKG}/cli.js --tray --skip-update` },
  { pid: SELF, ppid: LAUNCHER, uid: ME, args: "next-server (v16.0.0)" },
  { pid: 4001, ppid: LAUNCHER, uid: ME, args: "/home/me/.cache/node-systray/2.1.4/tray_linux_release" },
  { pid: 5001, ppid: SELF, uid: ME, args: `${DATA}/bin/cloudflared tunnel run --dns-resolver-addrs 1.1.1.1:53 --token t` },
  { pid: 3900, ppid: 1, uid: ME, args: `/usr/bin/node ${DATA}/runtime/updater/updater.js` },
];
const NOT_OURS = [
  { pid: 6001, ppid: 777, uid: ME, args: "node server.js" },
  { pid: 6002, ppid: 777, uid: ME, args: "node ." },
  { pid: 6003, ppid: 777, uid: ME, args: "next-server (v16.0.0)" },
  { pid: 7000, ppid: 1, uid: ME, args: "/usr/bin/node --dns-result-order=ipv4first /home/me/dev/10router/cli/cli.js" },
  { pid: 7001, ppid: 7005, uid: ME, args: `${DATA}/bin/cloudflared tunnel --url http://127.0.0.1:20200 --no-autoupdate` },
  { pid: 7002, ppid: 1, uid: ME, args: `/usr/bin/node ${DATA}/runtime/updater/updater.js` },
  { pid: 8001, ppid: LAUNCHER, uid: OTHER_USER, args: "/home/other/.cache/node-systray/2.1.4/tray_linux_release" },
];

let stateDir;
function launcherState(children, launcherPid = LAUNCHER) {
  const file = path.join(stateDir, `${launcherPid}.json`);
  fs.writeFileSync(file, JSON.stringify({ launcherPid, children }));
  return file;
}

function collect({ env = {}, cloudflaredPid = null, parent = LAUNCHER, platform = "linux" } = {}) {
  return collectAppPids({ env: { PORT: "20128", ...env }, self: SELF, parent, uid: platform === "win32" ? undefined : ME, platform, cloudflaredPid });
}

describe("collectAppPids", () => {
  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "10router-launchers-"));
    table = [...OURS, ...NOT_OURS];
    listFails = false;
    execFileSync.mockClear();
  });
  afterEach(() => {
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it("stops what this install recorded: tray, cloudflared, updater, then the launcher", () => {
    const env = {
      TENROUTER_LAUNCHER_PID: String(LAUNCHER),
      TENROUTER_LAUNCHER_STATE: launcherState({ tray: 4001 }),
      TENROUTER_UPDATER_PID: "3900",
    };

    expect(collect({ env, cloudflaredPid: 5001 })).toEqual([4001, 5001, 3900, LAUNCHER]);
    // Only the recorded PIDs are looked up; nothing lists every process.
    expect(execFileSync).toHaveBeenCalledTimes(1);
    const [cmd, args, options] = execFileSync.mock.calls[0];
    expect(cmd).toBe("ps");
    expect(args).toEqual(["-o", "pid=,ppid=,uid=,args=", "-p", `4001,5001,3900,${LAUNCHER}`]);
    expect(options.maxBuffer).toBeGreaterThan(1024 * 1024);
  });

  it("never kills a user's own programs, even when a stale record points at them", () => {
    const env = {
      TENROUTER_LAUNCHER_PID: String(LAUNCHER),
      // PIDs recycled since they were recorded.
      TENROUTER_LAUNCHER_STATE: launcherState({ tray: 6001 }),
      TENROUTER_UPDATER_PID: "6003",
    };

    expect(collect({ env, cloudflaredPid: 6002 })).toEqual([LAUNCHER]);
  });

  it("leaves another install's cloudflared and updater alone", () => {
    // The cloudflared PID file in a shared DATA_DIR names another install's tunnel.
    expect(collect({ cloudflaredPid: 7001 })).toEqual([]);
    // Another install's updater runs, but this one was not relaunched by it.
    expect(collect({ env: { TENROUTER_UPDATER_PID: "" } })).toEqual([]);
    expect(execFileSync.mock.calls.flatMap((call) => call[1].at(-1).split(","))).not.toContain("7002");
  });

  it("stops a quick tunnel for this port that a previous server left behind", () => {
    table.push({ pid: 5101, ppid: 1, uid: ME, args: `${DATA}/bin/cloudflared tunnel --url http://127.0.0.1:20128 --config /tmp/c/config.yml` });
    expect(collect({ cloudflaredPid: 5101 })).toEqual([5101]);
  });

  it("trusts the launcher only while it is still this server's parent", () => {
    const env = { TENROUTER_LAUNCHER_PID: String(LAUNCHER), TENROUTER_LAUNCHER_STATE: launcherState({ tray: 4001 }) };
    // Reparented (launcher gone) or the variable was inherited from elsewhere.
    expect(collect({ env, parent: 1 })).toEqual([]);
    expect(collect({ env, parent: 7000 })).toEqual([]);
  });

  it("ignores a state file written for a different launcher", () => {
    const file = launcherState({ tray: 4001 }, 7000);
    expect(collect({ env: { TENROUTER_LAUNCHER_PID: String(LAUNCHER), TENROUTER_LAUNCHER_STATE: file } })).toEqual([LAUNCHER]);
  });

  it("skips another user's process", () => {
    const env = { TENROUTER_LAUNCHER_PID: String(LAUNCHER), TENROUTER_LAUNCHER_STATE: launcherState({ tray: 8001 }) };
    expect(collect({ env })).toEqual([LAUNCHER]);
  });

  it("works when the CLI and updater run under Bun", () => {
    table = [
      { pid: LAUNCHER, ppid: 1, uid: ME, args: `/home/me/.bun/bin/bun ${PKG}/cli.js --tray` },
      { pid: 3900, ppid: 1, uid: ME, args: `/home/me/.bun/bin/bun ${DATA}/runtime/updater/updater.js` },
    ];
    const env = { TENROUTER_LAUNCHER_PID: String(LAUNCHER), TENROUTER_UPDATER_PID: "3900" };
    expect(collect({ env })).toEqual([3900, LAUNCHER]);
  });

  it("kills nothing when the process table can't be read (BusyBox ps)", () => {
    listFails = true;
    const env = { TENROUTER_LAUNCHER_PID: String(LAUNCHER), TENROUTER_UPDATER_PID: "3900" };
    expect(collect({ env, cloudflaredPid: 5001 })).toEqual([]);
  });

  it("doesn't read the process table when nothing was recorded", () => {
    expect(collect()).toEqual([]);
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it("uses the same recorded PIDs on Windows", () => {
    table = [
      { pid: LAUNCHER, ppid: 900, args: `"C:\\Program Files\\nodejs\\node.exe" --dns-result-order=ipv4first "C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\10router\\cli.js" --tray` },
      { pid: 4001, ppid: LAUNCHER, args: `powershell.exe -NoProfile -File "C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\10router\\src\\cli\\tray\\tray.ps1"` },
      { pid: 5001, ppid: SELF, args: `"C:\\Users\\me\\AppData\\Roaming\\9router\\bin\\cloudflared.exe" tunnel run --token t` },
      { pid: 7001, ppid: 7005, args: `"C:\\Users\\me\\AppData\\Roaming\\9router\\bin\\cloudflared.exe" tunnel --url http://127.0.0.1:20200` },
    ];
    const env = { TENROUTER_LAUNCHER_PID: String(LAUNCHER), TENROUTER_LAUNCHER_STATE: launcherState({ tray: 4001 }) };

    expect(collect({ env, cloudflaredPid: 5001, platform: "win32" })).toEqual([4001, 5001, LAUNCHER]);
    expect(collect({ env: {}, cloudflaredPid: 7001, platform: "win32" })).toEqual([]);
    const [cmd, args, options] = execFileSync.mock.calls[0];
    expect(cmd).toBe("powershell.exe");
    expect(args.at(-1)).toContain("ProcessId=4001 OR ProcessId=5001 OR ProcessId=4000");
    expect(options.maxBuffer).toBeGreaterThan(1024 * 1024);

    listFails = true;
    expect(collect({ env, cloudflaredPid: 5001, platform: "win32" })).toEqual([]);
  });
});

describe("killAppProcesses", () => {
  it("sends SIGKILL to the recorded PIDs only", async () => {
    const uid = process.getuid?.();
    if (uid === undefined) return; // POSIX-only path
    table = [{ pid: 3900, ppid: 1, uid, args: `/usr/bin/node ${DATA}/runtime/updater/updater.js` }, ...NOT_OURS];
    listFails = false;
    vi.stubEnv("TENROUTER_UPDATER_PID", "3900");
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    try {
      await killAppProcesses();
      expect(kill.mock.calls).toEqual([[3900, "SIGKILL"]]);
    } finally {
      kill.mockRestore();
      vi.unstubAllEnvs();
    }
  });
});
