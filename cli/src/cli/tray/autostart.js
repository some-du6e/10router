const fs = require("fs");
const path = require("path");
const os = require("os");
const childProcess = require("child_process");
const { getBackgroundArgs } = require("../utils/launchArgs");

const APP_NAME = "10router";
const APP_LABEL = "com.10router.autostart";

// Everything this module reads from the machine. Tests pass their own.
function system() {
  return {
    platform: process.platform,
    pid: process.pid,
    uid: process.getuid?.(),
    execPath: process.execPath,
    argv1: process.argv[1],
    env: process.env,
    homedir: os.homedir(),
    fs,
    execSync: childProcess.execSync,
  };
}

// `launch` is { port, host, dataDir }: what the entry must start again.
// dataDir is the launcher's absolute DATA_DIR, or empty for the default.

// Every entry sets this, so cli.js knows its DATA_DIR came from an autostart
// file and checks who owns that directory before using it.
const AUTOSTART_ENV = "TENROUTER_AUTOSTART";

function entryEnv(launch) {
  const env = { [AUTOSTART_ENV]: "1" };
  if (launch.dataDir) env.DATA_DIR = launch.dataDir;
  return env;
}

// None of the entry formats can carry a line break safely.
function refuseLineBreaks(values) {
  for (const value of values) {
    if (/[\r\n]/.test(value)) throw new Error(`autostart can't use a path with a line break: ${JSON.stringify(value)}`);
  }
  return values;
}

function escapeXml(value) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

// Desktop Entry spec: quote the argument and backslash-escape " ` $ \ inside
// it, then apply the string-value escape (\ becomes \\) and write % as %%.
function quoteDesktopArg(value) {
  const quoted = `"${value.replace(/[\\"`$]/g, "\\$&")}"`;
  return quoted.replaceAll("\\", "\\\\").replaceAll("%", "%%");
}

// Windows command-line quoting (the rules CommandLineToArgvW and node.exe
// parse by): backslashes are literal except before a quote, where they are
// doubled, and a quote inside the argument becomes \".
function quoteWindowsArg(value) {
  let out = '"';
  let backslashes = 0;
  for (const ch of value) {
    if (ch === "\\") {
      backslashes++;
    } else if (ch === '"') {
      out += "\\".repeat(backslashes * 2 + 1) + '"';
      backslashes = 0;
    } else {
      out += "\\".repeat(backslashes) + ch;
      backslashes = 0;
    }
  }
  return out + "\\".repeat(backslashes * 2) + '"';
}

// A VBScript string literal: quotes are doubled.
const vbsString = (value) => `"${value.replaceAll('"', '""')}"`;

function macLogPaths(homedir) {
  const dir = path.posix.join(homedir, "Library", "Logs", APP_NAME);
  return { dir, out: path.posix.join(dir, "10router.log"), err: path.posix.join(dir, "10router.error.log") };
}

// Where LaunchAgents written before 10router moved its logs sent them.
const OLD_MAC_LOGS = ["/tmp/10router.log", "/tmp/10router.error.log"];

function macLaunchAgent(nodePath, routerScript, launch, logs) {
  // EnvironmentVariables.PATH includes node's bin dir so child processes
  // spawned by cli.js (npm install at runtime, etc.) resolve.
  const env = { PATH: `${path.posix.dirname(nodePath)}:/usr/local/bin:/usr/bin:/bin`, ...entryEnv(launch) };
  refuseLineBreaks(Object.values(env));
  const args = refuseLineBreaks([nodePath, routerScript, ...getBackgroundArgs(launch)]);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${APP_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
${args.map((arg) => `        <string>${escapeXml(arg)}</string>`).join("\n")}
    </array>
    <key>EnvironmentVariables</key>
    <dict>
${Object.entries(env).map(([k, v]) => `        <key>${k}</key>\n        <string>${escapeXml(v)}</string>`).join("\n")}
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <false/>
    <key>StandardOutPath</key>
    <string>${escapeXml(logs.out)}</string>
    <key>StandardErrorPath</key>
    <string>${escapeXml(logs.err)}</string>
</dict>
</plist>`;
}

// Run node + cli.js directly, hidden window. Avoids the fragile `10router.cmd`
// lookup that depended on the npm prefix path. WshShell.Run expands %NAME% in
// its command, in one pass, so each % is written as %TENROUTER_PCT%, which the
// script sets to "%".
function windowsStartupScript(nodePath, routerScript, launch) {
  const command = refuseLineBreaks([nodePath, routerScript, ...getBackgroundArgs(launch)])
    .map(quoteWindowsArg)
    .join(" ")
    .replaceAll("%", "%TENROUTER_PCT%");
  const lines = [
    'Set WshShell = CreateObject("WScript.Shell")',
    'Set ProcessEnv = WshShell.Environment("Process")',
    'ProcessEnv("TENROUTER_PCT") = "%"',
  ];
  for (const [name, value] of Object.entries(entryEnv(launch))) {
    lines.push(`ProcessEnv("${name}") = ${vbsString(refuseLineBreaks([value])[0])}`);
  }
  lines.push(`WshShell.Run ${vbsString(command)}, 0, False`, "");
  return lines.join("\r\n");
}

// WSH reads a script as ANSI unless it starts with a UTF-16LE byte order
// mark, which would garble a non-ASCII user folder.
function encodeVbs(text) {
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]);
}

function linuxDesktopEntry(nodePath, routerScript, launch) {
  const env = Object.entries(entryEnv(launch)).map(([name, value]) => `${name}=${value}`);
  const command = refuseLineBreaks(["env", ...env, nodePath, routerScript, ...getBackgroundArgs(launch)]);
  return `[Desktop Entry]
Type=Application
Name=10router
Comment=10router API Proxy
Exec=${command.map(quoteDesktopArg).join(" ")}
Hidden=false
NoDisplay=false
X-GNOME-Autostart-enabled=true
`;
}

/**
 * Resolve the absolute path to this package's cli.js.
 *
 * Order of preference:
 *   1. Explicit `cliPath` argument — cleanest, used when called from running
 *      cli.js with `__filename`.
 *   2. `process.argv[1]` if it's our cli.js — true when 10router is currently
 *      running and the tray menu fires this code path.
 *   3. Compute relative to this file's own location. autostart.js lives at
 *      `<pkg>/src/cli/tray/autostart.js`, so cli.js is three levels up.
 *      This works for any global install layout (nvm, Volta, asdf, Homebrew,
 *      /usr/local, etc.) without depending on `npm bin -g` (removed in npm 9)
 *      or a hardcoded `/usr/local/...` path.
 *
 * Returns null if no candidate exists — callers should not write an autostart
 * entry pointing at a non-existent script.
 */
function getCliJsPath(cliPath, sys) {
  const p = pathFor(sys);
  if (cliPath) {
    const resolved = p.resolve(cliPath);
    if (sys.fs.existsSync(resolved)) return resolved;
  }
  if (sys.argv1) {
    const resolved = p.resolve(sys.argv1);
    if (p.basename(resolved) === "cli.js" && sys.fs.existsSync(resolved)) {
      return resolved;
    }
  }
  const computed = path.resolve(__dirname, "..", "..", "..", "cli.js");
  if (sys.fs.existsSync(computed)) return computed;
  return null;
}

/**
 * Enable auto startup on OS login
 * @param {string} cliPath - Optional path to cli.js (defaults to auto-detect)
 * @param {{port: number, host: string, dataDir?: string}} launch
 * @returns {boolean} success
 */
function enableAutoStart(cliPath, launch, sys = system()) {
  const { platform } = sys;

  if (!["darwin", "win32", "linux"].includes(platform)) return false;
  if (platform === "linux" && !sys.env.DISPLAY) return false;

  try {
    if (platform === "darwin") return enableMacOS(cliPath, launch, sys);
    if (platform === "win32") return enableWindows(cliPath, launch, sys);
    if (platform === "linux") return enableLinux(cliPath, launch, sys);
  } catch (err) {
    // Silent fail — autostart is optional
  }
  return false;
}

/**
 * Disable auto startup
 * @returns {boolean} success
 */
function disableAutoStart(sys = system()) {
  try {
    if (sys.platform === "darwin") return disableMacOS(sys);
    if (sys.platform === "win32") return disableWindows(sys);
    if (sys.platform === "linux") return disableLinux(sys);
  } catch (err) {}
  return false;
}

// Paths follow the target platform's rules (the host's, outside tests).
const pathFor = (sys) => (sys.platform === "win32" ? path.win32 : path.posix);

function entryPath(sys) {
  if (sys.platform === "darwin") return path.posix.join(sys.homedir, "Library", "LaunchAgents", `${APP_LABEL}.plist`);
  if (sys.platform === "win32") return path.win32.join(sys.env.APPDATA || "", "Microsoft", "Windows", "Start Menu", "Programs", "Startup", `${APP_NAME}.vbs`);
  if (sys.platform === "linux") return path.posix.join(sys.homedir, ".config", "autostart", `${APP_NAME}.desktop`);
  return null;
}

/**
 * Autostart is on when its entry exists. On macOS that is the plist: it is
 * written but not loaded while this instance runs (see enableMacOS), and
 * launchd loads it at the next login.
 */
function isAutoStartEnabled(sys = system()) {
  try {
    const file = entryPath(sys);
    return !!file && sys.fs.existsSync(file);
  } catch (e) {
    return false;
  }
}

// ============ macOS ============

/**
 * Returns true when the current Node process IS the running instance that
 * launchd is managing under our agent label.
 *
 * `launchctl unload <plist>` for an Aqua user-domain agent sends SIGTERM to
 * the running process. When the running cli.js was itself started by the
 * autostart agent, an unload from the tray's "Disable Auto-start" would kill
 * the process handling the click.
 */
function isAgentSelfMacOS(sys) {
  try {
    const output = sys.execSync(`launchctl list ${APP_LABEL}`, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3000
    });
    const match = output.match(/"PID"\s*=\s*(\d+)/);
    return !!(match && parseInt(match[1], 10) === sys.pid);
  } catch (e) {
    return false;
  }
}

// The tray's output includes the first-run setup token, so its logs are the
// user's own: ~/Library/Logs/10router, 0700, files 0600.
function prepareMacLogs(sys) {
  const logs = macLogPaths(sys.homedir);
  sys.fs.mkdirSync(logs.dir, { recursive: true, mode: 0o700 });
  sys.fs.chmodSync(logs.dir, 0o700);
  for (const file of [logs.out, logs.err]) {
    sys.fs.closeSync(sys.fs.openSync(file, "a", 0o600));
    sys.fs.chmodSync(file, 0o600);
  }
  return logs;
}

function enableMacOS(cliPath, launch, sys) {
  const plistPath = entryPath(sys);
  sys.fs.mkdirSync(path.posix.dirname(plistPath), { recursive: true });

  // Invoke node + cli.js directly with absolute paths — no shell wrapper.
  const routerScript = getCliJsPath(cliPath, sys);
  // Don't write a broken plist that references a non-existent script.
  if (!routerScript) return false;

  const logs = prepareMacLogs(sys);
  sys.fs.writeFileSync(plistPath, macLaunchAgent(sys.execPath, routerScript, launch, logs));

  // No `launchctl load`: this is only ever called from a running instance,
  // and RunAtLoad would start a second one right away (a second tray icon,
  // and servers failing on the taken port). launchd loads the plist at the
  // next login.
  return true;
}

// True when this process's stdout or stderr is the file `st` describes.
function writesTo(st, sys) {
  return [1, 2].some((fd) => {
    try {
      const out = sys.fs.fstatSync(fd);
      return out.dev === st.dev && out.ino === st.ino;
    } catch {
      return false;
    }
  });
}

// A LaunchAgent written by an older 10router logs to /tmp/10router.log, which
// every user can read and which holds the setup token. Point it at the
// private log folder (the rest of the plist is kept; launchd reads it at the
// next login) and delete the old logs if they are this user's own files.
// Returns true when it changed something.
function migrateMacLogs(sys = system()) {
  if (sys.platform !== "darwin") return false;
  try {
    const plistPath = entryPath(sys);
    if (!sys.fs.existsSync(plistPath)) return false;
    const plist = String(sys.fs.readFileSync(plistPath, "utf8"));
    if (!OLD_MAC_LOGS.some((file) => plist.includes(`<string>${file}</string>`))) return false;
    const logs = prepareMacLogs(sys);
    const moved = plist
      .replaceAll(`<string>${OLD_MAC_LOGS[0]}</string>`, `<string>${escapeXml(logs.out)}</string>`)
      .replaceAll(`<string>${OLD_MAC_LOGS[1]}</string>`, `<string>${escapeXml(logs.err)}</string>`);
    sys.fs.writeFileSync(plistPath, moved);
    for (const file of OLD_MAC_LOGS) {
      try {
        // lstat: never follow a symlink someone planted in /tmp.
        const st = sys.fs.lstatSync(file);
        if (!st.isFile() || st.uid !== sys.uid) continue;
        // Started by that old agent, this process is still writing to the
        // file: make it private instead of deleting what it writes to.
        if (writesTo(st, sys)) sys.fs.chmodSync(file, 0o600);
        else sys.fs.unlinkSync(file);
      } catch { /* not there */ }
    }
    return true;
  } catch {
    return false;
  }
}

function disableMacOS(sys) {
  const plistPath = entryPath(sys);

  // Don't kill ourselves: when the current process is the running agent,
  // `launchctl unload` would send SIGTERM. Removing the plist is enough to
  // keep it from starting at the next login.
  if (!isAgentSelfMacOS(sys)) {
    try {
      sys.execSync(`launchctl unload "${plistPath}"`, { stdio: "ignore" });
    } catch (e) {}
  }

  if (sys.fs.existsSync(plistPath)) {
    sys.fs.unlinkSync(plistPath);
  }
  return true;
}

// ============ Windows ============

function enableWindows(cliPath, launch, sys) {
  const vbsPath = entryPath(sys);
  if (!sys.fs.existsSync(path.win32.dirname(vbsPath))) return false;

  const routerScript = getCliJsPath(cliPath, sys);
  if (!routerScript) return false;

  sys.fs.writeFileSync(vbsPath, encodeVbs(windowsStartupScript(sys.execPath, routerScript, launch)));
  return true;
}

function disableWindows(sys) {
  const vbsPath = entryPath(sys);
  if (sys.fs.existsSync(vbsPath)) {
    sys.fs.unlinkSync(vbsPath);
  }
  return true;
}

// ============ Linux ============

function enableLinux(cliPath, launch, sys) {
  const desktopPath = entryPath(sys);
  const autostartDir = path.posix.dirname(desktopPath);

  if (!sys.fs.existsSync(autostartDir)) {
    try { sys.fs.mkdirSync(autostartDir, { recursive: true }); }
    catch (e) { return false; }
  }

  const routerScript = getCliJsPath(cliPath, sys);
  if (!routerScript) return false;

  sys.fs.writeFileSync(desktopPath, linuxDesktopEntry(sys.execPath, routerScript, launch));
  return true;
}

function disableLinux(sys) {
  const desktopPath = entryPath(sys);
  if (sys.fs.existsSync(desktopPath)) {
    sys.fs.unlinkSync(desktopPath);
  }
  return true;
}

module.exports = {
  enableAutoStart,
  disableAutoStart,
  isAutoStartEnabled,
  migrateMacLogs,
  AUTOSTART_ENV,
  macLaunchAgent,
  windowsStartupScript,
  linuxDesktopEntry
};
