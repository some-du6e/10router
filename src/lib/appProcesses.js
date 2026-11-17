import { execFileSync } from "child_process";
import fs from "fs";
import { loadPid as loadCloudflaredPid } from "@/lib/tunnel/cloudflare/pid.js";

// Shutdown and update stop only processes this install started and recorded:
// - the CLI launcher that spawned this server (it passes its PID in the env),
// - what that launcher recorded in its state file (the tray), if still its child,
// - the cloudflared this server spawned (PID file, then its parent or --url port),
// - the updater that relaunched this install (it passes its PID in the env).
// Nothing is matched by name or path, and if the process table can't be read
// (BusyBox ps, no PowerShell) nothing is killed.
export const LAUNCHER_PID_ENV = "TENROUTER_LAUNCHER_PID";
export const LAUNCHER_STATE_ENV = "TENROUTER_LAUNCHER_STATE";
export const UPDATER_PID_ENV = "TENROUTER_UPDATER_PID";

const LIST_TIMEOUT_MS = 5000;
const LIST_MAX_BUFFER = 16 * 1024 * 1024;
const KILL_TIMEOUT_MS = 3000;
const PROCESS_WAIT_MS = 1500;
const UPDATER_SCRIPT = /[\\/]updater[\\/]updater\.js(?=["\s]|$)/;

function toPid(value) {
  const pid = typeof value === "number" ? value : /^\d+$/.test(String(value ?? "").trim()) ? Number(value) : NaN;
  return Number.isSafeInteger(pid) && pid > 1 ? pid : null;
}

function programName(args) {
  const match = String(args || "").match(/^\s*(?:"([^"]+)"|(\S+))/);
  const program = match ? match[1] ?? match[2] : "";
  return program.split(/[\\/]/).pop();
}

function isCloudflared(args) {
  return /^cloudflared(\.exe)?$/i.test(programName(args));
}

function servesPort(args, port) {
  if (!/^\d+$/.test(port)) return false;
  return new RegExp(`--url\\s+"?https?://(?:127\\.0\\.0\\.1|localhost):${port}(?![0-9])`).test(args);
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

function readPosix(pids) {
  let out = "";
  try {
    out = execFileSync("ps", ["-o", "pid=,ppid=,uid=,args=", "-p", pids.join(",")], {
      encoding: "utf8", timeout: LIST_TIMEOUT_MS, maxBuffer: LIST_MAX_BUFFER, stdio: ["ignore", "pipe", "ignore"],
    });
  } catch (err) {
    // ps exits non-zero when some PIDs are gone; keep the rows it did print.
    out = typeof err?.stdout === "string" ? err.stdout : "";
  }
  const infos = new Map();
  for (const line of out.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s?(.*)$/);
    if (m) infos.set(Number(m[1]), { ppid: Number(m[2]), uid: Number(m[3]), args: m[4] });
  }
  return infos;
}

function readWindows(pids) {
  const filter = pids.map((pid) => `ProcessId=${pid}`).join(" OR ");
  const script = `Get-CimInstance Win32_Process -Filter '${filter}' | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress`;
  const infos = new Map();
  try {
    const out = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8", timeout: LIST_TIMEOUT_MS, maxBuffer: LIST_MAX_BUFFER, windowsHide: true, stdio: ["ignore", "pipe", "ignore"],
    });
    const parsed = JSON.parse(out.trim() || "[]");
    for (const row of Array.isArray(parsed) ? parsed : [parsed]) {
      const pid = toPid(row?.ProcessId);
      if (pid) infos.set(pid, { ppid: Number(row.ParentProcessId), uid: null, args: String(row.CommandLine || "") });
    }
  } catch { /* unreadable: nothing is killed */ }
  return infos;
}

// PIDs to stop, children first and the launcher last. Never includes this process.
export function collectAppPids({
  env = process.env,
  self = process.pid,
  parent = process.ppid,
  uid = process.getuid?.(),
  platform = process.platform,
  cloudflaredPid = loadCloudflaredPid(),
} = {}) {
  const checks = new Map();
  const add = (pid, check) => {
    if (!pid || pid === self) return;
    checks.set(pid, [...(checks.get(pid) || []), check]);
  };

  const launcher = toPid(env[LAUNCHER_PID_ENV]);
  const ownLauncher = launcher !== null && launcher === parent;
  if (ownLauncher) {
    for (const child of readLauncherChildren(env[LAUNCHER_STATE_ENV], launcher)) {
      add(child, (info) => info.ppid === launcher);
    }
  }

  const port = String(env.PORT || "");
  add(toPid(cloudflaredPid), (info) => isCloudflared(info.args) && (info.ppid === self || servesPort(info.args, port)));
  add(toPid(env[UPDATER_PID_ENV]), (info) => UPDATER_SCRIPT.test(info.args));
  if (ownLauncher) add(launcher, () => true);

  if (!checks.size) return [];
  const pids = [...checks.keys()];
  const infos = platform === "win32" ? readWindows(pids) : readPosix(pids);
  return pids.filter((pid) => {
    const info = infos.get(pid);
    if (!info) return false;
    if (platform !== "win32" && info.uid !== uid) return false;
    return checks.get(pid).some((check) => check(info));
  });
}

// Stop this install's other processes so an update can replace its files.
export async function killAppProcesses() {
  const pids = collectAppPids();
  for (const pid of pids) {
    try {
      if (process.platform === "win32") {
        execFileSync("taskkill", ["/F", "/PID", String(pid)], { stdio: "ignore", windowsHide: true, timeout: KILL_TIMEOUT_MS });
      } else {
        process.kill(pid, "SIGKILL");
      }
    } catch { /* already gone */ }
  }
  if (pids.length > 0) await new Promise((resolve) => setTimeout(resolve, PROCESS_WAIT_MS));
}
