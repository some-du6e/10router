// One launcher per DATA_DIR. Two servers on one data directory would share
// its database, tunnel PID file and CLI secret, and a different bind address
// on the same port does not stop the second from starting.
//
// The lock file holds the holder's PID and that process's start time. A lock
// is live only while a process with that PID and that start time exists, so a
// launcher killed without running its exit handlers (SIGKILL from an update,
// Windows logoff) or a PID reused after a reboot leaves a lock that is simply
// taken over.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");

const LOCK_FILE = "launcher.lock";

function lockPath(dataDir) {
  return path.join(dataDir, LOCK_FILE);
}

// A string that identifies one run of a process, or null when there is no
// such process (or it can't be read, e.g. another user's).
function processStartTime(pid, {
  platform = process.platform,
  readFile = fs.readFileSync,
  run = execFileSync,
} = {}) {
  try {
    if (platform === "win32") {
      const script = "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;"
        + `$p = Get-CimInstance Win32_Process -Filter 'ProcessId=${Number(pid)}'; if ($p) { $p.CreationDate.ToUniversalTime().ToString('o') }`;
      const out = String(run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", windowsHide: true, timeout: 5000 })).trim();
      return out || null;
    }
    try {
      // Field 22 of /proc/<pid>/stat is the start time in clock ticks since
      // boot. The command name (field 2) can hold spaces and parentheses, so
      // count from its closing parenthesis.
      const stat = String(readFile(`/proc/${pid}/stat`, "utf8"));
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      return fields[19] ? `ticks:${fields[19]}` : null;
    } catch (err) {
      if (err?.code !== "ENOENT") return null;
      // ENOENT: no such process, or no /proc at all (macOS). ps tells which.
    }
    const out = String(run("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8", timeout: 3000, env: { ...process.env, LC_ALL: "C" } })).trim();
    return out ? `lstart:${out}` : null;
  } catch {
    return null;
  }
}

function parseHolder(raw) {
  try {
    const { pid, startTime } = JSON.parse(raw);
    return Number.isSafeInteger(pid) && pid > 0 && typeof startTime === "string" && startTime ? { pid, startTime } : null;
  } catch {
    return null;
  }
}

function readRaw(file) {
  try { return fs.readFileSync(file, "utf8"); } catch { return null; }
}

const holderRuns = (holder) => processStartTime(holder.pid) === holder.startTime;

const unique = () => `${process.pid}.${crypto.randomBytes(6).toString("hex")}`;

// Creates `file` holding `content`, or returns false if it already exists. The
// content is written to a temp file first and hard-linked into place, so no
// reader ever sees an empty or half-written lock.
function createAtomically(file, content) {
  const tmp = `${file}.${unique()}.tmp`;
  fs.writeFileSync(tmp, content, { flag: "wx", mode: 0o600 });
  try {
    fs.linkSync(tmp, file);
    return true;
  } catch (err) {
    if (err?.code === "EEXIST") return false;
    throw err;
  } finally {
    try { fs.unlinkSync(tmp); } catch { }
  }
}

// Removes a stale lock without ever removing someone else's fresh one: the
// lock is renamed to a unique name (atomic), and only deleted if what was
// moved is still exactly the stale content that was judged. Otherwise another
// launcher replaced it in between, and it is put back.
function removeStale(file, staleRaw) {
  const aside = `${file}.stale.${unique()}`;
  try {
    fs.renameSync(file, aside);
  } catch {
    return; // already gone, or moved by another launcher
  }
  if (readRaw(aside) !== staleRaw) {
    try { fs.linkSync(aside, file); } catch { }
  }
  try { fs.unlinkSync(aside); } catch { }
}

// Returns { ok: true, release } or { ok: false, holder, file }.
function tryLock(dataDir, {
  pid = process.pid,
  startTime = processStartTime(process.pid),
  isRunning = holderRuns,
} = {}) {
  const file = lockPath(dataDir);
  const content = JSON.stringify({ pid, startTime });
  const release = () => {
    if (readRaw(file) === content) {
      try { fs.unlinkSync(file); } catch { }
    }
  };
  const unlocked = { ok: true, release: () => {} };
  // Without our own start time nobody could ever tell this lock is stale.
  if (!startTime) return unlocked;

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
      if (createAtomically(file, content)) return { ok: true, release };
    } catch {
      // Can't lock at all (read-only dir, no hard links on this filesystem):
      // run unlocked rather than refuse to start.
      return unlocked;
    }
    const raw = readRaw(file);
    if (raw === null) continue; // released in between
    const holder = parseHolder(raw);
    if (holder && holder.pid !== pid && isRunning(holder)) return { ok: false, holder, file };
    removeStale(file, raw);
  }
  return { ok: false, holder: parseHolder(readRaw(file) ?? ""), file };
}

// Waits up to waitMs for a holder to let go.
async function acquireDataDirLock(dataDir, { waitMs = 3000, intervalMs = 100, ...options } = {}) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const result = tryLock(dataDir, options);
    if (result.ok || Date.now() >= deadline) return result;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

// A DATA_DIR another user owns or can write to could hand this launcher a
// database, tunnel binary or CLI secret of their choosing. Returns why it is
// unsafe, or null. POSIX only; a directory that doesn't exist yet is fine.
function unsafeDataDirReason(dir, { stat = fs.statSync, uid = process.getuid?.() } = {}) {
  if (uid === undefined) return null;
  let st;
  try { st = stat(dir); } catch { return null; }
  if (st.uid !== uid) return `it is owned by user ${st.uid}, not you (${uid})`;
  if (st.mode & 0o022) return `group or other users can write to it (mode ${(st.mode & 0o777).toString(8)})`;
  return null;
}

module.exports = { acquireDataDirLock, tryLock, lockPath, processStartTime, unsafeDataDirReason, LOCK_FILE };
