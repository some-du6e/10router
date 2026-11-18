// One launcher per DATA_DIR. Two servers on one data directory would share
// its database, tunnel PID file and CLI secret, and a different bind address
// on the same port does not stop the second from starting.
//
// The lock file holds the holder's PID and that process's start time. A lock
// is live while a process with that PID and that start time exists, so a
// launcher killed without running its exit handlers (SIGKILL from an update,
// Windows logoff) or a PID reused after a reboot leaves a lock that is simply
// taken over. When the holder's start time can't be read, it counts as live.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");

const LOCK_FILE = "launcher.lock";

// processStartTime() result when it couldn't tell (timeout, no ps, no
// permission), as opposed to null: there is no such process.
const UNKNOWN = Symbol("start time unknown");

function lockPath(dataDir) {
  return path.join(dataDir, LOCK_FILE);
}

// ps exits 1 when it finds no such process.
const notFound = (err) => err?.status === 1 && !err.signal;

// A string that identifies one run of a process; null when there is no such
// process; UNKNOWN when it couldn't be read.
function processStartTime(pid, {
  platform = process.platform,
  readFile = fs.readFileSync,
  run = execFileSync,
} = {}) {
  if (platform === "win32") {
    try {
      const script = "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;"
        + `$p = Get-CimInstance Win32_Process -Filter 'ProcessId=${Number(pid)}'; if ($p) { $p.CreationDate.ToUniversalTime().ToString('o') }`;
      const out = String(run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", windowsHide: true, timeout: 5000 })).trim();
      return out || null;
    } catch {
      return UNKNOWN;
    }
  }
  try {
    // Field 22 of /proc/<pid>/stat is the start time in clock ticks since
    // boot. The command name (field 2) can hold spaces and parentheses, so
    // count from its closing parenthesis.
    const stat = String(readFile(`/proc/${pid}/stat`, "utf8"));
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return fields[19] ? `ticks:${fields[19]}` : UNKNOWN;
  } catch (err) {
    // ENOENT: no such process, or no /proc at all (macOS); ps tells which.
    if (err?.code !== "ENOENT") return UNKNOWN;
  }
  try {
    // lstart is local time; UTC keeps a timezone change from making a live
    // holder look like another process.
    const out = String(run("ps", ["-p", String(pid), "-o", "lstart="], {
      encoding: "utf8", timeout: 3000, env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
    })).trim();
    return out ? `lstart:${out}` : null;
  } catch (err) {
    return notFound(err) ? null : UNKNOWN;
  }
}

// Only a definite "different start time" or "no such process" makes a lock stale.
function holderRuns(holder, probe = processStartTime) {
  const now = probe(holder.pid);
  return now === UNKNOWN || now === holder.startTime;
}

function ownStartTime() {
  const value = processStartTime(process.pid);
  return typeof value === "string" ? value : null;
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

// Removes a stale lock without removing someone else's fresh one: the lock is
// renamed to a unique name (atomic) and deleted only if what moved is still
// the stale content that was judged. Otherwise another launcher replaced it in
// between, and it is put back. Returns "conflict" when putting it back fails
// because a third launcher has created a lock meanwhile.
function removeStale(file, staleRaw) {
  const aside = `${file}.stale.${unique()}`;
  try {
    fs.renameSync(file, aside);
  } catch {
    return "gone"; // already removed, or moved by another launcher
  }
  let result = "removed";
  if (readRaw(aside) !== staleRaw) {
    result = "restored";
    try {
      fs.linkSync(aside, file);
    } catch (err) {
      if (err?.code === "EEXIST") result = "conflict";
    }
  }
  try { fs.unlinkSync(aside); } catch { }
  return result;
}

// Returns { ok: true, release } or { ok: false, holder, file[, conflict] }.
// Without startTime nothing is written (no one could tell later that the lock
// went stale), but a live holder still refuses.
function tryLock(dataDir, { pid = process.pid, startTime = ownStartTime(), isRunning = holderRuns } = {}) {
  const file = lockPath(dataDir);
  const content = startTime ? JSON.stringify({ pid, startTime }) : null;
  const release = () => {
    if (content && readRaw(file) === content) {
      try { fs.unlinkSync(file); } catch { }
    }
  };
  const live = (raw) => {
    const holder = parseHolder(raw);
    return holder && holder.pid !== pid && isRunning(holder) ? holder : null;
  };

  if (!content) {
    const holder = live(readRaw(file) ?? "");
    return holder ? { ok: false, holder, file } : { ok: true, release };
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
      if (createAtomically(file, content)) return { ok: true, release };
    } catch {
      // Can't create a lock at all (read-only dir, no hard links on this
      // filesystem): still refuse a live holder, else run unlocked.
      const holder = live(readRaw(file) ?? "");
      return holder ? { ok: false, holder, file } : { ok: true, release: () => {} };
    }
    const raw = readRaw(file);
    if (raw === null) continue; // released in between
    const holder = live(raw);
    if (holder) return { ok: false, holder, file };
    if (removeStale(file, raw) === "conflict") {
      return { ok: false, holder: parseHolder(readRaw(file) ?? ""), file, conflict: true };
    }
  }
  return { ok: false, holder: parseHolder(readRaw(file) ?? ""), file };
}

// Waits up to waitMs for a holder to let go. Reads this launcher's own start
// time once.
async function acquireDataDirLock(dataDir, { waitMs = 3000, intervalMs = 100, startTime = ownStartTime(), ...options } = {}) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const result = tryLock(dataDir, { ...options, startTime });
    if (result.ok || result.conflict || Date.now() >= deadline) return result;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

// A DATA_DIR another user owns or can write to could hand this launcher a
// database, tunnel binary, CLI secret or npm config of their choosing. Returns
// why it is unsafe, or null. POSIX only; a directory that doesn't exist yet is
// fine.
function unsafeDataDirReason(dir, { stat = fs.statSync, uid = process.getuid?.() } = {}) {
  if (uid === undefined) return null;
  let st;
  try { st = stat(dir); } catch { return null; }
  if (st.uid !== uid) return `it is owned by user ${st.uid}, not you (${uid})`;
  if (st.mode & 0o022) return `group or other users can write to it (mode ${(st.mode & 0o777).toString(8)})`;
  return null;
}

module.exports = { acquireDataDirLock, tryLock, lockPath, processStartTime, holderRuns, unsafeDataDirReason, LOCK_FILE, UNKNOWN };
