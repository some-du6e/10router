// One launcher per DATA_DIR. Two servers on one data directory would share
// its database, tunnel PID file and CLI secret, and a different bind address
// on the same port does not stop the second from starting. The lock file holds
// the holder's PID and runtime; a lock whose PID no longer runs that runtime
// (exited, or reused after a reboot) is stale and taken over.
const fs = require("fs");
const path = require("path");
const { runsBinary } = require("./pidFile");

const LOCK_FILE = "launcher.lock";

function lockPath(dataDir) {
  return path.join(dataDir, LOCK_FILE);
}

function readHolder(file) {
  try {
    const { pid, execPath } = JSON.parse(fs.readFileSync(file, "utf8"));
    return Number.isSafeInteger(pid) && pid > 0 && typeof execPath === "string" ? { pid, execPath } : null;
  } catch {
    return null;
  }
}

const holderRuns = (holder) => runsBinary(holder.pid, holder.execPath);

// Returns { ok: true, release } or { ok: false, holder, file }.
function tryLock(dataDir, { pid = process.pid, execPath = process.execPath, isRunning = holderRuns } = {}) {
  const file = lockPath(dataDir);
  const release = () => {
    if (readHolder(file)?.pid === pid) {
      try { fs.unlinkSync(file); } catch { }
    }
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(file, JSON.stringify({ pid, execPath }), { flag: "wx", mode: 0o600 });
      return { ok: true, release };
    } catch (err) {
      // Can't create a lock at all (read-only dir and the like): run unlocked
      // rather than refuse to start.
      if (err?.code !== "EEXIST") return { ok: true, release: () => {} };
    }
    const holder = readHolder(file);
    if (holder && holder.pid !== pid && isRunning(holder)) return { ok: false, holder, file };
    try { fs.unlinkSync(file); } catch { }
  }
  return { ok: false, holder: readHolder(file), file };
}

// Waits up to waitMs for a holder to let go: a tray handoff starts the new
// launcher just before the old one exits.
async function acquireDataDirLock(dataDir, { waitMs = 3000, intervalMs = 100, ...options } = {}) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const result = tryLock(dataDir, options);
    if (result.ok || Date.now() >= deadline) return result;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

module.exports = { acquireDataDirLock, tryLock, lockPath };
