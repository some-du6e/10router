import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { loadPid as loadCloudflaredPid } from "@/lib/tunnel/cloudflare/pid.js";
import { getDataDir } from "@/lib/dataDir";

// Shutdown and update stop only processes this install started and recorded:
// - the CLI launcher that spawned this server (it passes its PID in the env),
// - what that launcher recorded in its state file (the tray), if still its child,
// - the cloudflared this server spawned (its handle, else the PID file plus its
//   parent or --url port),
// - the updater that relaunched this install (it passes its PID in the env).
// Nothing is matched by name, and if the process table can't be read (BusyBox
// ps, no PowerShell) nothing but this server's own cloudflared is stopped.
// cli/src/cli/utils/launcherState.js and src/lib/updater/updater.js write the
// env names below; tests/unit/app-updater-kill-sweep.test.js checks they agree.
export const LAUNCHER_PID_ENV = "TENROUTER_LAUNCHER_PID";
export const LAUNCHER_STATE_ENV = "TENROUTER_LAUNCHER_STATE";
export const UPDATER_PID_ENV = "TENROUTER_UPDATER_PID";

const LIST_TIMEOUT_MS = 5000;
const LIST_MAX_BUFFER = 16 * 1024 * 1024;
const KILL_TIMEOUT_MS = 3000;
const PROCESS_WAIT_MS = 1500;
const OWN_CLOUDFLARED = Symbol.for("10router.ownCloudflared");
export const POWERSHELL_UTF8 = "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;";

function toPid(value) {
  const pid = typeof value === "number" ? value : /^\d+$/.test(String(value ?? "").trim()) ? Number(value) : NaN;
  return Number.isSafeInteger(pid) && pid > 1 ? pid : null;
}

function tokensOf(args) {
  return [...String(args || "").matchAll(/"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2]);
}

function isCloudflared(args) {
  const program = tokensOf(args)[0] || "";
  return /^cloudflared(\.exe)?$/i.test(program.split(/[\\/]/).pop());
}

function servesPort(args, port) {
  if (!/^\d+$/.test(port)) return false;
  return new RegExp(`--url\\s+"?https?://(?:127\\.0\\.0\\.1|localhost):${port}(?![0-9])`).test(args);
}

// Where appUpdater copies the updater script (the 9router dir name is kept for
// existing installs).
export function runtimeUpdaterPath(env = process.env, platform = process.platform) {
  const paths = platform === "win32" ? path.win32 : path.posix;
  const dataDir = env.DATA_DIR
    || (platform === "win32"
      ? paths.join(env.APPDATA || paths.join(os.homedir(), "AppData", "Roaming"), "9router")
      : paths.join(os.homedir(), ".9router"));
  return paths.join(dataDir, "runtime", "updater", "updater.js");
}

// The CLI launcher's one-per-DATA_DIR lock (cli/src/cli/utils/dataDirLock.js).
// getDataDir applies the same fallbacks as the CLI's copy (a Unix-style path
// on Windows, a DATA_DIR it can't create), so this is the file the launcher
// locked.
export const LAUNCHER_LOCK_FILE = "launcher.lock";

export function launcherLockPath() {
  return path.join(getDataDir(), LAUNCHER_LOCK_FILE);
}

// A launcher killed here can't remove its lock. Remove it only while it still
// names that launcher, so a newer launcher's lock is never touched.
function removeLauncherLock(launcherPid) {
  const file = launcherLockPath();
  try {
    if (JSON.parse(fs.readFileSync(file, "utf8"))?.pid === launcherPid) fs.unlinkSync(file);
  } catch { /* no lock, or not readable */ }
}

// The CLI package this server runs from: <pkg>/app/custom-server.js → <pkg>.
function defaultInstallRoot() {
  const script = process.argv[1];
  return script ? path.dirname(path.dirname(path.resolve(script))) : null;
}

function readLauncherChildren(stateFile, launcherPid) {
  if (!stateFile) return [];
  try {
    const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    if (toPid(state?.launcherPid) !== launcherPid) return [];
    return Object.values(state.children || {}).map(toPid).filter(Boolean);
  } catch {
    return [];
  }
}

// `[[dd-]hh:]mm:ss` → seconds.
function parseElapsed(text) {
  const m = String(text).match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
  if (!m) return null;
  return ((Number(m[1] || 0) * 24 + Number(m[2] || 0)) * 60 + Number(m[3])) * 60 + Number(m[4]);
}

function readPosix(pids, now) {
  let out = "";
  try {
    out = execFileSync("ps", ["-o", "pid=,ppid=,uid=,etime=,args=", "-p", pids.join(",")], {
      encoding: "utf8", timeout: LIST_TIMEOUT_MS, maxBuffer: LIST_MAX_BUFFER, stdio: ["ignore", "pipe", "ignore"],
    });
  } catch (err) {
    // ps exits non-zero when some PIDs are gone; keep the rows it did print.
    out = typeof err?.stdout === "string" ? err.stdout : "";
  }
  const infos = new Map();
  for (const line of out.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s?(.*)$/);
    if (!m) continue;
    const elapsed = parseElapsed(m[4]);
    infos.set(Number(m[1]), { ppid: Number(m[2]), uid: Number(m[3]), created: elapsed === null ? null : now - elapsed * 1000, args: m[5] });
  }
  return infos;
}

function readWindows(filter) {
  const created = "@{n='Created';e={if ($_.CreationDate) { ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() } else { $null }}}";
  // Windows PowerShell 5.1 writes a piped stdout in the OEM code page and its
  // ConvertTo-Json leaves non-ASCII unescaped, so a profile path like
  // C:\Users\José would reach Node (decoding UTF-8) mangled and match nothing.
  const script = `${POWERSHELL_UTF8}Get-CimInstance Win32_Process -Filter "${filter}" | Select-Object ProcessId,ParentProcessId,CommandLine,${created} | ConvertTo-Json -Compress`;
  const infos = new Map();
  try {
    const out = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8", timeout: LIST_TIMEOUT_MS, maxBuffer: LIST_MAX_BUFFER, windowsHide: true, stdio: ["ignore", "pipe", "ignore"],
    });
    const parsed = JSON.parse(out.trim() || "[]");
    for (const row of Array.isArray(parsed) ? parsed : [parsed]) {
      const pid = toPid(row?.ProcessId);
      const createdMs = Number(row?.Created);
      if (pid) infos.set(pid, { ppid: Number(row.ParentProcessId), uid: null, created: Number.isFinite(createdMs) && row.Created !== null ? createdMs : null, args: String(row.CommandLine || "") });
    }
  } catch { /* unreadable: nothing is killed */ }
  return infos;
}

function context(ctx) {
  const platform = ctx.platform ?? process.platform;
  const env = ctx.env ?? process.env;
  return {
    env,
    platform,
    isWin: platform === "win32",
    paths: platform === "win32" ? path.win32 : path.posix,
    self: ctx.self ?? process.pid,
    parent: ctx.parent ?? process.ppid,
    uid: "uid" in ctx ? ctx.uid : process.getuid?.(),
    now: ctx.now ?? Date.now(),
    serverStart: ctx.serverStart ?? Date.now() - process.uptime() * 1000,
    installRoot: "installRoot" in ctx ? ctx.installRoot : defaultInstallRoot(),
    updaterPath: ctx.updaterPath ?? runtimeUpdaterPath(env, platform),
    cloudflaredPid: "cloudflaredPid" in ctx ? ctx.cloudflaredPid : loadCloudflaredPid(),
    realpath: ctx.realpath ?? ((p) => fs.realpathSync.native(p)),
  };
}

// A test for whether a command line runs `file`. Absolute paths are also
// compared after resolving links, since a shim may launch through a junction or
// symlinked npm prefix (nvm-windows) while this server sees the real path.
// Resolving can block for seconds on an offline mapped drive or share, so only
// tokens with the target's file name are resolved, and the target only once.
// Relative tokens are never resolved: they belong to the other process's cwd.
function fileMatcher(c, file) {
  if (!file) return () => false;
  const real = (p) => {
    try { return c.realpath(p); } catch { return p; }
  };
  const norm = (p) => (c.isWin ? c.paths.normalize(p).toLowerCase() : c.paths.normalize(p));
  const baseOf = (p) => (c.isWin ? c.paths.basename(p).toLowerCase() : c.paths.basename(p));
  const targetBase = baseOf(file);
  const targets = new Set([norm(file), c.paths.isAbsolute(file) ? norm(real(file)) : norm(file)]);
  return (info) => tokensOf(info.args).some((token) => {
    if (targets.has(norm(token))) return true;
    if (!c.paths.isAbsolute(token) || baseOf(token) !== targetBase) return false;
    return targets.has(norm(real(token)));
  });
}

// What to stop: PIDs (children first, the launcher last), the launcher if it
// is among them, and its state file.
export function planKills(ctx = {}) {
  const c = context(ctx);
  const launcher = toPid(c.env[LAUNCHER_PID_ENV]);
  const ownLauncher = launcher !== null && launcher === c.parent ? launcher : null;
  const stateFile = ownLauncher ? c.env[LAUNCHER_STATE_ENV] || null : null;
  const children = ownLauncher ? readLauncherChildren(stateFile, ownLauncher) : [];
  const cloudflared = toPid(c.cloudflaredPid);
  const updater = toPid(c.env[UPDATER_PID_ENV]);
  const wanted = [...new Set([...children, cloudflared, updater, ownLauncher])].filter((pid) => pid && pid !== c.self);
  const none = { pids: [], launcher: null, stateFile: null };
  if (!wanted.length) return none;

  // This server's own row comes back too, so its start time is read with the
  // same clock and conversion as the others (immune to wall-clock steps).
  const queried = [...wanted, c.self];
  const infos = c.isWin ? readWindows(queried.map((pid) => `ProcessId=${pid}`).join(" OR ")) : readPosix(queried, c.now);
  const serverStart = infos.get(c.self)?.created ?? c.serverStart;
  const mine = (pid) => {
    const info = infos.get(pid);
    return info && (c.isWin || info.uid === c.uid) ? info : null;
  };

  // On Windows a parent PID outlives the parent, so the launcher must also be
  // this install's cli.js and older than this server.
  let launcherInfo = ownLauncher ? mine(ownLauncher) : null;
  if (launcherInfo && c.isWin) {
    const cli = c.installRoot ? c.paths.join(c.installRoot, "cli.js") : null;
    const older = launcherInfo.created !== null && launcherInfo.created <= serverStart;
    if (!fileMatcher(c, cli)(launcherInfo) || !older) launcherInfo = null;
  }

  const keep = new Set();
  if (launcherInfo) {
    for (const pid of children) {
      const info = mine(pid);
      const newer = !c.isWin || (info?.created != null && info.created >= launcherInfo.created);
      if (info && info.ppid === ownLauncher && newer) keep.add(pid);
    }
  }
  if (cloudflared) {
    const info = mine(cloudflared);
    const ourChild = info && info.ppid === c.self && (!c.isWin || (info.created != null && info.created >= serverStart));
    if (info && isCloudflared(info.args) && (ourChild || servesPort(info.args, String(c.env.PORT || "")))) keep.add(cloudflared);
  }
  if (updater) {
    // The updater relaunched this install, so it started before this server.
    const info = mine(updater);
    if (info && fileMatcher(c, c.updaterPath)(info) && info.created != null && info.created <= serverStart) keep.add(updater);
  }

  const pids = wanted.filter((pid) => keep.has(pid) && pid !== ownLauncher);
  if (!launcherInfo) return { pids, launcher: null, stateFile: null };
  return { pids: [...pids, ownLauncher], launcher: ownLauncher, stateFile };
}

export function collectAppPids(ctx = {}) {
  return planKills(ctx).pids;
}

// Windows can't replace files a running process holds, so an update while
// another instance of this install runs fails mid-install. Lists node/bun
// processes running this install's cli.js or server, other than this server
// and its launcher. Empty elsewhere, or when the list can't be read.
export function busyInstallPids(ctx = {}) {
  const c = context(ctx);
  if (!c.isWin || !c.installRoot) return [];
  // The launcher is excluded whether or not planKills could verify it, so a
  // slow first listing or a clock step never turns it into "another instance".
  const launcher = toPid(c.env[LAUNCHER_PID_ENV]);
  const exclude = new Set([c.self, launcher === c.parent ? launcher : null].filter(Boolean));
  const matchers = [
    c.paths.join(c.installRoot, "cli.js"),
    c.paths.join(c.installRoot, "app", "custom-server.js"),
    c.paths.join(c.installRoot, "app", "server.js"),
  ].map((file) => fileMatcher(c, file));
  const infos = readWindows("Name='node.exe' OR Name='bun.exe'");
  return [...infos].filter(([pid, info]) => !exclude.has(pid) && matchers.some((runs) => runs(info))).map(([pid]) => pid);
}

export function busyInstallMessage(pids) {
  return `Another 10router from this install is running (PID ${pids.join(", ")}); stop it, then update.`;
}

// cloudflared.js registers the child it spawns, so shutdown can stop it by its
// handle (marking the exit as intentional) even when the process table is unreadable.
export function rememberOwnCloudflared(child, stop) {
  globalThis[OWN_CLOUDFLARED] = { child, stop };
  child.once?.("exit", () => {
    if (globalThis[OWN_CLOUDFLARED]?.child === child) delete globalThis[OWN_CLOUDFLARED];
  });
}

function stopOwnCloudflared() {
  const own = globalThis[OWN_CLOUDFLARED];
  if (!own) return null;
  delete globalThis[OWN_CLOUDFLARED];
  try { own.stop(); } catch { /* already gone */ }
  return own.child?.pid ?? null;
}

// Stop this install's other processes so an update can replace its files.
export async function killAppProcesses() {
  const ownCloudflared = stopOwnCloudflared();
  const { pids, stateFile, launcher } = planKills();
  let killed = ownCloudflared ? 1 : 0;
  for (const pid of pids) {
    if (pid === ownCloudflared) continue;
    try {
      if (process.platform === "win32") {
        execFileSync("taskkill", ["/F", "/PID", String(pid)], { stdio: "ignore", windowsHide: true, timeout: KILL_TIMEOUT_MS });
      } else {
        process.kill(pid, "SIGKILL");
      }
      killed++;
      if (pid === launcher) removeLauncherLock(launcher);
    } catch { /* already gone */ }
  }
  // A SIGKILLed launcher can't remove its own state file.
  if (stateFile) {
    try { fs.unlinkSync(stateFile); } catch { /* gone */ }
  }
  if (killed > 0) await new Promise((resolve) => setTimeout(resolve, PROCESS_WAIT_MS));
}
