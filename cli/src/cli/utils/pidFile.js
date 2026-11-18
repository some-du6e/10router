// Stop a tunnel process the server recorded in a PID file. A PID file can name
// a process that is no longer ours: one from a container sharing DATA_DIR, or
// a PID reused after a reboot. So the PID is killed only while its program is
// one of the expected names; otherwise the stale file is just removed.
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

// Program name (without directory or .exe, lower case) of a running PID, or
// null when it can't be read.
function programName(pid, { platform = process.platform, run = execFileSync } = {}) {
  try {
    let name;
    if (platform === "win32") {
      const out = String(run("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], { encoding: "utf8", windowsHide: true, timeout: 3000 }));
      const row = out.match(/^"([^"]+)","(\d+)"/m);
      if (!row || Number(row[2]) !== pid) return null;
      name = row[1];
    } else {
      name = String(run("ps", ["-p", String(pid), "-o", "comm="], { encoding: "utf8", timeout: 3000 })).trim();
    }
    if (!name) return null;
    return path.basename(name.replace(/\\/g, "/")).toLowerCase().replace(/\.exe$/, "");
  } catch {
    return null;
  }
}

// Returns true when it killed the process.
function killByPidFile(pidFile, expectedNames, { platform = process.platform, run = execFileSync, kill = process.kill.bind(process) } = {}) {
  try {
    if (!fs.existsSync(pidFile)) return false;
    const pid = parseInt(fs.readFileSync(pidFile, "utf8").trim(), 10);
    let killed = false;
    if (pid > 0 && expectedNames.includes(programName(pid, { platform, run }))) {
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

module.exports = { programName, killByPidFile };
