// Stop the cloudflared the server recorded in a PID file. A PID file can name
// a process that is no longer ours: one from a container sharing DATA_DIR, or
// a PID reused after a reboot. So the PID is killed only while it runs the
// server's own binary; otherwise the stale file is just removed.
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

function samePath(a, b, realpath) {
  const real = (p) => { try { return realpath(p); } catch { return path.resolve(p); } };
  return real(a) === real(b);
}

// True only when pid is running expectedPath (the server's
// <DATA_DIR>/bin/cloudflared, or cloudflared.exe on Windows).
function runsBinary(pid, expectedPath, {
  platform = process.platform,
  run = execFileSync,
  readlink = fs.readlinkSync,
  realpath = fs.realpathSync,
} = {}) {
  const expectedName = path.basename(expectedPath).toLowerCase();
  try {
    if (platform === "win32") {
      // tasklist only gives the image name.
      const out = String(run("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], { encoding: "utf8", windowsHide: true, timeout: 3000 }));
      const row = out.match(/^"([^"]+)","(\d+)"/m);
      return !!row && Number(row[2]) === pid && row[1].toLowerCase() === expectedName;
    }

    // Linux (BusyBox included): /proc/<pid>/exe is the binary itself.
    try {
      return samePath(readlink(`/proc/${pid}/exe`), expectedPath, realpath);
    } catch (e) {
      // Another user's process: not ours to kill.
      if (e?.code === "EACCES" || e?.code === "EPERM") return false;
    }

    // No /proc (macOS): its ps prints the full path of the binary.
    const comm = String(run("ps", ["-p", String(pid), "-o", "comm="], { encoding: "utf8", timeout: 3000 })).trim();
    if (!comm) return false;
    if (path.isAbsolute(comm)) return samePath(comm, expectedPath, realpath);
    return path.basename(comm) === path.basename(expectedPath);
  } catch {
    return false;
  }
}

// Returns true when it killed the process.
function killByPidFile(pidFile, expectedPath, options = {}) {
  const { platform = process.platform, run = execFileSync, kill = process.kill.bind(process) } = options;
  try {
    if (!fs.existsSync(pidFile)) return false;
    const pid = parseInt(fs.readFileSync(pidFile, "utf8").trim(), 10);
    let killed = false;
    if (pid > 0 && runsBinary(pid, expectedPath, { ...options, platform, run })) {
      try {
        if (platform === "win32") {
          run("taskkill", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore", windowsHide: true, timeout: 3000 });
        } else {
          kill(pid, "SIGKILL");
        }
        killed = true;
      } catch { }
    }
    try { fs.unlinkSync(pidFile); } catch { }
    return killed;
  } catch {
    return false;
  }
}

module.exports = { runsBinary, killByPidFile };
