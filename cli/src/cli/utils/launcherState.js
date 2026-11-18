// Records the processes this launcher starts (the tray) in a file named after
// its own PID, and hands that path to the server it spawns. On shutdown or
// update the server stops exactly these, never anything matched by name.
// Read by src/lib/appProcesses.js.
const fs = require("fs");
const path = require("path");
const { getRuntimeDir } = require("../../../hooks/sqliteRuntime");

const LAUNCHER_PID_ENV = "TENROUTER_LAUNCHER_PID";
const LAUNCHER_STATE_ENV = "TENROUTER_LAUNCHER_STATE";

const children = {};
let registered = false;

function stateFile() {
  return path.join(getRuntimeDir(), "launchers", `${process.pid}.json`);
}

function write() {
  const file = stateFile();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, JSON.stringify({ launcherPid: process.pid, children }), { mode: 0o600 });
  } catch { /* best effort: without the file the server leaves the tray alone */ }
  if (!registered) {
    registered = true;
    process.on("exit", () => { try { fs.unlinkSync(file); } catch { /* gone */ } });
  }
}

function recordChild(role, pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1) return;
  children[role] = pid;
  write();
}

function forgetChild(role) {
  if (!(role in children)) return;
  delete children[role];
  write();
}

// Env for the server child: who launched it and where the record lives.
function launcherEnv() {
  return { [LAUNCHER_PID_ENV]: String(process.pid), [LAUNCHER_STATE_ENV]: stateFile() };
}

module.exports = { recordChild, forgetChild, launcherEnv, stateFile };
