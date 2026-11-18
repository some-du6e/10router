import { spawn } from "child_process";
import path from "path";
import fs from "fs";
import { UPDATER_CONFIG } from "@/shared/constants/config";
import { runtimeUpdaterPath } from "./appProcesses.js";

export { collectAppPids, killAppProcesses, busyInstallPids, busyInstallMessage } from "./appProcesses.js";

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

// Copy updater.js into DATA_DIR so npm -g can overwrite node_modules safely.
function ensureRuntimeUpdater(bundledPath) {
  try {
    if (!bundledPath || !fs.existsSync(bundledPath)) return bundledPath;
    const runtimePath = runtimeUpdaterPath();
    const runtimeDir = path.dirname(runtimePath);
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

// Resolve npx to relaunch after update (cross-platform). `npx 10router` works
// regardless of global bin path changes after npm i -g.
function resolveRelaunchCommand() {
  return { cmd: process.platform === "win32" ? "npx.cmd" : "npx" };
}

// The address a local client dials for a server bound to `bindHost`
// (mirrors cli/src/cli/api/client.js hostForBind).
export function dialHostForBind(bindHost) {
  const host = String(bindHost || "").trim().replace(/^\[(.*)\]$/, "$1");
  if (!host || host === "0.0.0.0" || host === "localhost") return "127.0.0.1";
  if (host === "::") return "::1";
  return host;
}

// Where this server listens. Under the CLI launcher (TENROUTER_LAUNCHER_PID
// set) PORT and HOSTNAME are the --port/--host it was started with; without
// it, HOSTNAME is usually just the machine's name, so it is not a bind.
export function serverBind(env = process.env) {
  const port = parseInt(env.PORT, 10) || UPDATER_CONFIG.appPort;
  const host = env.TENROUTER_LAUNCHER_PID && env.HOSTNAME ? env.HOSTNAME : "";
  return { port, host };
}

// Relaunch matching the original launch: tray stays tray, foreground stays
// foreground, and a --host/--port bind comes back on the same address.
export function buildRelaunchArgs(env = process.env) {
  const { port, host } = serverBind(env);
  const args = [UPDATER_CONFIG.npmPackageName];
  if (env.TRAY_MODE === "1") args.push("--tray");
  args.push("--skip-update", "--port", String(port));
  if (host) args.push("--host", host);
  return args;
}

// Spawn detached headless updater (Node process) then exit current server
export function spawnUpdaterAndExit(packageName = UPDATER_CONFIG.npmPackageName) {
  const updaterPath = ensureRuntimeUpdater(resolveBundledUpdaterPath());
  const relaunch = resolveRelaunchCommand();
  const relaunchArgs = buildRelaunchArgs();
  const bind = serverBind();

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
      // The updater waits for this server's port to free up, then for the
      // relaunched one to answer, on the address it is bound to.
      UPDATER_APP_PORT: String(bind.port),
      UPDATER_APP_HOST: dialHostForBind(bind.host),
      UPDATER_RELAUNCH: "1",
      UPDATER_RELAUNCH_CMD: relaunch.cmd,
      UPDATER_RELAUNCH_ARGS: JSON.stringify(relaunchArgs),
    },
  }).unref();

  setTimeout(() => process.exit(0), UPDATER_CONFIG.exitDelayMs);
}
