// The CLI's copy of src/lib/dataDir.js, which is ESM and bundled into the
// server so the CLI can't load it. Both must pick the same directory, or the
// CLI token, tunnel PID files and runtime modules end up somewhere the server
// never looks; tests/unit/cli-data-dir.test.js checks they agree. It lives in
// hooks/ because the postinstall loads this folder on its own.
const fs = require("fs");
const os = require("os");
const path = require("path");

// Intentionally still "9router": kept for existing installs.
const APP_NAME = "9router";

function defaultDir() {
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), APP_NAME);
  }
  return path.join(os.homedir(), `.${APP_NAME}`);
}

function getDataDir() {
  const configured = process.env.DATA_DIR;
  if (!configured) return defaultDir();

  // The server ignores a Unix-style path on Windows (from a Linux .env).
  if (process.platform === "win32" && /^\//.test(configured)) return defaultDir();

  try {
    fs.mkdirSync(configured, { recursive: true, mode: 0o700 });
    return configured;
  } catch (e) {
    if (e?.code === "EACCES" || e?.code === "EPERM") return defaultDir();
    throw e;
  }
}

// The server runs with another working directory than the shell the CLI was
// started from, so a relative DATA_DIR (or a quoted "~/...") has to be made
// absolute before the server is spawned. A Unix-style path on Windows is left
// alone so the server still ignores it.
function absoluteDataDir(value, cwd = process.cwd()) {
  if (!value) return value;
  if (process.platform === "win32" && /^\//.test(value)) return value;
  let dir = value;
  if (dir === "~" || dir.startsWith("~/") || dir.startsWith("~\\")) dir = path.join(os.homedir(), dir.slice(1));
  return path.resolve(cwd, dir);
}

module.exports = { getDataDir, absoluteDataDir };
