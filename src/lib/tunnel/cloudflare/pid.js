import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import { TUNNEL_DIR, ensureTunnelDir } from "../shared/state.js";

const PID_FILE = path.join(TUNNEL_DIR, "cloudflared.pid");

export function savePid(pid) {
  ensureTunnelDir();
  fs.writeFileSync(PID_FILE, pid.toString());
}

// The file outlives the process that wrote it (it sits in DATA_DIR, which a
// Docker volume keeps across restarts), so its PID may now belong to anyone.
// In a fresh container this server is PID 1, and 0 or a negative number
// would signal a whole process group: never hand those out to be killed.
export function usablePid(value, self = process.pid, parent = process.ppid) {
  const pid = typeof value === "number" ? value : /^\s*\d+\s*$/.test(String(value ?? "")) ? Number(value) : NaN;
  if (!Number.isSafeInteger(pid) || pid <= 1 || pid === self || pid === parent) return null;
  return pid;
}

export function loadPid() {
  try {
    if (fs.existsSync(PID_FILE)) return usablePid(fs.readFileSync(PID_FILE, "utf8"));
  } catch { /* ignore */ }
  return null;
}

export function clearPid(expectedPid = null) {
  try {
    if (!fs.existsSync(PID_FILE)) return false;
    if (expectedPid !== null && loadPid() !== expectedPid) return false;
    fs.unlinkSync(PID_FILE);
    return true;
  } catch { /* ignore */ }
  return false;
}

function samePath(a, b, realpath) {
  const real = (p) => { try { return realpath(p); } catch { return path.resolve(p); } };
  return real(a) === real(b);
}

/**
 * True only while `pid` runs the binary at `expectedPath`, the same check the
 * CLI makes (cli/src/cli/utils/pidFile.js): /proc/<pid>/exe on Linux, the full
 * path `ps` prints where there is no /proc, the image name on Windows.
 */
export function runsBinary(pid, expectedPath, {
  platform = process.platform,
  run = execFileSync,
  readlink = fs.readlinkSync,
  realpath = fs.realpathSync,
} = {}) {
  const expectedName = path.basename(expectedPath).toLowerCase();
  try {
    if (platform === "win32") {
      const out = String(run("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], { encoding: "utf8", windowsHide: true, timeout: 3000 }));
      const row = out.match(/^"([^"]+)","(\d+)"/m);
      return !!row && Number(row[2]) === pid && row[1].toLowerCase() === expectedName;
    }
    try {
      return samePath(readlink(`/proc/${pid}/exe`), expectedPath, realpath);
    } catch (e) {
      // Another user's process: not ours to signal.
      if (e?.code === "EACCES" || e?.code === "EPERM") return false;
    }
    const comm = String(run("ps", ["-p", String(pid), "-o", "comm="], { encoding: "utf8", timeout: 3000 })).trim();
    if (!comm) return false;
    if (path.isAbsolute(comm)) return samePath(comm, expectedPath, realpath);
    return path.basename(comm) === path.basename(expectedPath);
  } catch {
    return false;
  }
}

/**
 * The recorded PID, only while it still runs this server's cloudflared at
 * `binPath`. A value that could never be ours, or a process that is gone or
 * runs something else, removes the file and returns null.
 */
export function loadOwnPid(binPath, probe = {}) {
  let raw;
  try {
    if (!fs.existsSync(PID_FILE)) return null;
    raw = fs.readFileSync(PID_FILE, "utf8");
  } catch {
    return null;
  }
  const pid = usablePid(raw);
  if (pid !== null && runsBinary(pid, binPath, probe)) return pid;
  try { fs.unlinkSync(PID_FILE); } catch { /* already gone */ }
  return null;
}
