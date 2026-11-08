import { spawn, execSync } from "child_process";
import path from "path";
import fs from "fs";
import os from "os";
import { UPDATER_CONFIG } from "@/shared/constants/config";

const KILL_TIMEOUT_MS = 5000;
const PROCESS_WAIT_MS = 1500;

// Directories that only this install's processes run from: the CLI package
// (cli.js, bundled tray binaries), the standalone app, and DATA_DIR's
// downloaded binaries and runtime node_modules (cloudflared, tray).
function getInstallRoots() {
  const appDir = path.resolve(process.cwd());
  const pkgRoot = path.basename(appDir) === "app" ? path.dirname(appDir) : appDir;
  const dataDir = getDataDir();
  return [pkgRoot, path.join(dataDir, "bin"), path.join(dataDir, "runtime")]
    .map((dir) => path.resolve(dir) + path.sep);
}

// Collect PIDs of this install's own processes (excluding current): those the
// current OS user runs from this install's directories.
export function collectAppPids() {
  const pids = new Set();
  const self = String(process.pid);
  const isWin = process.platform === "win32";
  const roots = getInstallRoots().map((root) => (isWin ? root.toLowerCase() : root));
  const fromInstall = (cmdline) => {
    const text = isWin ? cmdline.toLowerCase() : cmdline;
    return roots.some((root) => text.includes(root));
  };

  if (isWin) {
    try {
      const psCmd = `powershell -NonInteractive -WindowStyle Hidden -Command "Get-WmiObject Win32_Process | Select-Object ProcessId,CommandLine | ConvertTo-Csv -NoTypeInformation"`;
      const output = execSync(psCmd, { encoding: "utf8", windowsHide: true, timeout: KILL_TIMEOUT_MS });
      output.split("\n").slice(1).forEach((line) => {
        const match = line.match(/^"(\d+)",(.*)$/);
        if (match && fromInstall(match[2])) pids.add(match[1]);
      });
    } catch { /* no processes */ }
  } else {
    const uid = String(process.getuid?.() ?? "");
    try {
      const output = execSync("ps -eo pid=,uid=,args= 2>/dev/null", { encoding: "utf8", timeout: KILL_TIMEOUT_MS });
      output.split("\n").forEach((line) => {
        const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
        if (match && match[2] === uid && fromInstall(match[3])) pids.add(match[1]);
      });
    } catch { /* no processes */ }
  }

  pids.delete(self);
  return [...pids];
}

// Copy updater.js into DATA_DIR so npm -g can overwrite node_modules safely.
// The "9router" / ".9router" dir name is deliberately kept for backward
// compatibility with existing installs — not a missed rebrand.
function getDataDir() {
  if (process.env.DATA_DIR) return process.env.DATA_DIR;
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "9router");
  }
  return path.join(os.homedir(), ".9router");
}

function resolveBundledUpdaterPath() {
  if (process.env.UPDATER_SCRIPT_PATH && fs.existsSync(process.env.UPDATER_SCRIPT_PATH)) {
    return process.env.UPDATER_SCRIPT_PATH;
  }
  // Production standalone: cwd is binAppDir (see bin/cli.js)
  // Dev: cwd is app/
  const fromCwd = path.join(process.cwd(), "src", "lib", "updater", "updater.js");
  if (fs.existsSync(fromCwd)) return fromCwd;
  const fromParent = path.join(process.cwd(), "..", "src", "lib", "updater", "updater.js");
  if (fs.existsSync(fromParent)) return fromParent;
  return fromCwd;
}

function ensureRuntimeUpdater(bundledPath) {
  try {
    if (!bundledPath || !fs.existsSync(bundledPath)) return bundledPath;
    const runtimeDir = path.join(getDataDir(), "runtime", "updater");
    const runtimePath = path.join(runtimeDir, "updater.js");
    if (fs.existsSync(runtimePath)) {
      try {
        if (fs.statSync(bundledPath).size === fs.statSync(runtimePath).size) return runtimePath;
      } catch { /* recopy */ }
    }
    fs.mkdirSync(runtimeDir, { recursive: true });
    fs.copyFileSync(bundledPath, runtimePath);
    return runtimePath;
  } catch {
    return bundledPath;
  }
}

// Kill all app-related processes to release file locks (esp. on Windows)
export async function killAppProcesses() {
  const pids = collectAppPids();
  const platform = process.platform;

  pids.forEach(pid => {
    try {
      if (platform === "win32") {
        execSync(`taskkill /F /PID ${pid} 2>nul`, { stdio: "ignore", shell: true, windowsHide: true, timeout: 3000 });
      } else {
        execSync(`kill -9 ${pid} 2>/dev/null`, { stdio: "ignore", timeout: 3000 });
      }
    } catch { /* already dead */ }
  });

  if (pids.length > 0) {
    await new Promise(r => setTimeout(r, PROCESS_WAIT_MS));
  }
}

// Resolve npx/10router binary to relaunch after update (cross-platform)
function resolveRelaunchCommand() {
  const isWin = process.platform === "win32";
  // Prefer `npx 10router` — works regardless of global bin path changes after npm i -g
  const npx = isWin ? "npx.cmd" : "npx";
  return { cmd: npx, args: [UPDATER_CONFIG.npmPackageName] };
}

// Spawn detached headless updater (Node process) then exit current server
export function spawnUpdaterAndExit(packageName = UPDATER_CONFIG.npmPackageName) {
  const updaterPath = ensureRuntimeUpdater(resolveBundledUpdaterPath());
  const isTray = process.env.TRAY_MODE === "1";
  const relaunch = resolveRelaunchCommand();
  // Relaunch matching original env: tray stays tray, foreground stays foreground
  const relaunchArgs = isTray
    ? [...relaunch.args, "--tray", "--skip-update"]
    : [...relaunch.args, "--skip-update"];

  spawn(process.execPath, [updaterPath], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: {
      ...process.env,
      UPDATER_PKG_NAME: packageName,
      UPDATER_PORT: String(UPDATER_CONFIG.statusPort),
      UPDATER_TAIL_LINES: String(UPDATER_CONFIG.statusLogTailLines),
      UPDATER_RETRIES: String(UPDATER_CONFIG.installRetries),
      UPDATER_RETRY_DELAY_MS: String(UPDATER_CONFIG.installRetryDelayMs),
      UPDATER_LINGER_MS: String(UPDATER_CONFIG.lingerAfterDoneMs),
      UPDATER_WAIT_MIN_MS: String(UPDATER_CONFIG.waitForExitMinMs),
      UPDATER_WAIT_MAX_MS: String(UPDATER_CONFIG.waitForExitMaxMs),
      UPDATER_WAIT_CHECK_MS: String(UPDATER_CONFIG.waitForExitCheckMs),
      UPDATER_APP_PORT: String(UPDATER_CONFIG.appPort),
      UPDATER_RELAUNCH: "1",
      UPDATER_RELAUNCH_CMD: relaunch.cmd,
      UPDATER_RELAUNCH_ARGS: JSON.stringify(relaunchArgs),
    },
  }).unref();

  setTimeout(() => process.exit(0), UPDATER_CONFIG.exitDelayMs);
}
