#!/usr/bin/env node

const { spawn, exec } = require("child_process");
const path = require("path");
const fs = require("fs");
const https = require("https");
const os = require("os");

// Native spinner - no external dependency
function createSpinner(text) {
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let i = 0;
  let interval = null;
  let currentText = text;
  return {
    start() {
      if (process.stdout.isTTY) {
        process.stdout.write(`\r${frames[0]} ${currentText}`);
        interval = setInterval(() => {
          process.stdout.write(`\r${frames[i++ % frames.length]} ${currentText}`);
        }, 80);
      }
      return this;
    },
    stop() {
      if (interval) {
        clearInterval(interval);
        interval = null;
      }
      if (process.stdout.isTTY) {
        process.stdout.write("\r\x1b[K");
      }
    },
    succeed(msg) {
      this.stop();
      console.log(`✅ ${msg}`);
    },
    fail(msg) {
      this.stop();
      console.log(`❌ ${msg}`);
    }
  };
}

const pkg = require("./package.json");
const { getDataDir, normalizeDataDirEnv } = require("./hooks/dataDir");
// Before anything reads it: the server starts in its own directory, so it and
// this process must get the same absolute DATA_DIR.
normalizeDataDirEnv(process.env);
const { ensureSqliteRuntime, buildEnvWithRuntime } = require("./hooks/sqliteRuntime");
const { ensureTrayRuntime } = require("./hooks/trayRuntime");
const { isValidHost, parsePort, getBackgroundArgs, serverStdio, attachServerOutput, setupTokenLive, bannerToStdout } = require("./src/cli/utils/launchArgs");
const { superviseServer } = require("./src/cli/utils/serverSupervisor");
const {
  hasExited, killServer, checkPortFree, waitServerReady, newLaunchNonce, provesLaunchNonce, createReadinessGate, LAUNCH_NONCE_ENV,
} = require("./src/cli/utils/serverProcess");
const { acquireDataDirLock, unsafeDataDirReason } = require("./src/cli/utils/dataDirLock");
const args = process.argv.slice(2);

// Subcommands (`10router xai video …`) run against an already-running gateway
// and bypass the launcher flow (no runtime self-heal, no server spawn).
if (args[0] === "xai" && args[1] === "video") {
  const { run } = require("./src/cli/commands/xaiVideo");
  run(args.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(`❌ ${err?.message || err}`);
      process.exit(1);
    });
  return;
}

// An autostart entry names its DATA_DIR in a file; refuse one that another
// user owns or can write to. This runs before the self-heal below, which runs
// npm in $DATA_DIR/runtime, where a planted .npmrc would run code as you.
const { AUTOSTART_ENV, migrateMacLogs, writesToLegacyLog } = require("./src/cli/tray/autostart");
if (process.env[AUTOSTART_ENV] === "1" && process.env.DATA_DIR) {
  const unsafe = unsafeDataDirReason(process.env.DATA_DIR);
  if (unsafe) {
    console.error(`\n❌ Not using DATA_DIR ${process.env.DATA_DIR} from the autostart entry: ${unsafe}.`);
    console.error(`   Make it yours and private (chown, then chmod go-w), or turn auto-start off and on again from the tray.`);
    process.exit(1);
  }
}

// Self-heal SQLite runtime deps (sql.js + better-sqlite3) into ~/.9router/runtime
// so the server can resolve them via NODE_PATH. Best-effort — sql.js is required,
// better-sqlite3 is optional. Logs to stderr only on failure.
try { ensureSqliteRuntime({ silent: true }); } catch {}

// Self-heal tray runtime (systray for macOS/Linux only). Windows skipped.
try { ensureTrayRuntime({ silent: true }); } catch {}

// Configuration constants
const APP_NAME = pkg.name; // Use from package.json
const INSTALL_CMD_LATEST = `npm i -g ${APP_NAME}@latest --prefer-online`;

const DEFAULT_PORT = 20128;
const DEFAULT_HOST = "0.0.0.0";

// First non-internal IPv4 — the address remote peers actually reach when bound to 0.0.0.0.
function getLanIp() {
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const i of ifaces || []) {
      if (i.family === "IPv4" && !i.internal) return i.address;
    }
  }
  return null;
}

// Local URL stays "localhost"; warn separately when bound to all interfaces (network-exposed).
function getDisplayHost() {
  return host === DEFAULT_HOST ? "localhost" : host;
}
// Parse arguments
let port = DEFAULT_PORT;
let host = DEFAULT_HOST;
let noBrowser = false;
let skipUpdate = false;
let showLog = false;
let trayMode = false;
// The last first-run setup banner the server printed. The menu redraw clears
// the screen, so the menu shows it again while setup is still pending.
let setupBanner = null;

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--port" || args[i] === "-p") {
    const parsed = parsePort(args[i + 1]);
    if (parsed === null) {
      console.error(`Invalid --port ${JSON.stringify(args[i + 1] ?? "")}: use a whole number from 1 to 65535.`);
      process.exit(1);
    }
    port = parsed;
    i++;
  } else if (args[i] === "--host" || args[i] === "-H") {
    host = args[i + 1] || DEFAULT_HOST;
    i++;
    if (!isValidHost(host)) {
      console.error(`Invalid --host ${JSON.stringify(host)}: use an IP address or a hostname (letters, digits, dots, hyphens).`);
      process.exit(1);
    }
  } else if (args[i] === "--no-browser" || args[i] === "-n") {
    noBrowser = true;
  } else if (args[i] === "--log" || args[i] === "-l") {
    showLog = true;
  } else if (args[i] === "--skip-update") {
    skipUpdate = true;
  } else if (args[i] === "--tray" || args[i] === "-t") {
    trayMode = true;
    process.env.TRAY_MODE = "1";
  } else if (args[i] === "--help" || args[i] === "-h") {
    console.log(`
Usage: ${APP_NAME} [options]

Options:
  -p, --port <port>   Port to run the server (default: ${DEFAULT_PORT})
  -H, --host <host>   Host to bind (default: ${DEFAULT_HOST})
  -n, --no-browser    Don't open browser automatically
  -l, --log           Show all server output (default: only the first-run
                      setup token; the rest is printed if the server crashes)
  -t, --tray          Run in system tray mode (background)
  --skip-update       Skip auto-update check
  -h, --help          Show this help message
  -v, --version       Show version

Commands:
  xai video --prompt "..." --output video.mp4
                      Generate a Grok Imagine video via the running gateway
                      (see: ${APP_NAME} xai video --help)
`);
    process.exit(0);
  } else if (args[i] === "--version" || args[i] === "-v") {
    console.log(pkg.version);
    process.exit(0);
  }
}

// Auto-relaunch after update: detached process has no TTY → fallback to tray
if (skipUpdate && !trayMode && !process.stdin.isTTY) {
  trayMode = true;
  process.env.TRAY_MODE = "1";
}

// Every request the launcher, menu and Terminal UI make goes to this address.
const api = require("./src/cli/api/client");
const dialHost = api.hostForBind(host);
api.configure({ port, host: dialHost });
const { launcherEnv } = require("./src/cli/utils/launcherState");

// Always use Node.js runtime with absolute path
const RUNTIME = process.execPath;

// Compare semver versions: returns 1 if a > b, -1 if a < b, 0 if equal
function compareVersions(a, b) {
  const partsA = a.split(".").map(Number);
  const partsB = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (partsA[i] > partsB[i]) return 1;
    if (partsA[i] < partsB[i]) return -1;
  }
  return 0;
}

// Kill the server's cloudflared by its PID file
function killTunnelByPidFile() {
  const { killByPidFile } = require("./src/cli/utils/pidFile");
  const dataDir = getDataDir();
  const binary = path.join(dataDir, "bin", process.platform === "win32" ? "cloudflared.exe" : "cloudflared");
  killByPidFile(path.join(dataDir, "tunnel", "cloudflared.pid"), binary);
}

// Detect if running in restricted environment (Codespaces, Docker)
function isRestrictedEnvironment() {
  // Check for Codespaces
  if (process.env.CODESPACES === "true" || process.env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN) {
    return "GitHub Codespaces";
  }

  // Check for Docker
  if (fs.existsSync("/.dockerenv") || (fs.existsSync("/proc/1/cgroup") && fs.readFileSync("/proc/1/cgroup", "utf8").includes("docker"))) {
    return "Docker";
  }

  return null;
}

// Check if new version available, return latest version or null
function checkForUpdate() {
  return new Promise((resolve) => {
    if (skipUpdate) {
      resolve(null);
      return;
    }

    const spinner = createSpinner("Checking for updates...").start();
    let resolved = false;

    const safetyTimeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        spinner.stop();
        resolve(null);
      }
    }, 8000);

    const done = (version) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(safetyTimeout);
      spinner.stop();
      resolve(version);
    };

    const req = https.get(`https://registry.npmjs.org/${pkg.name}/latest`, { timeout: 3000 }, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        try {
          const latest = JSON.parse(data);
          if (latest.version && compareVersions(latest.version, pkg.version) > 0) {
            done(latest.version);
          } else {
            done(null);
          }
        } catch (e) {
          done(null);
        }
      });
    });

    req.on("error", () => done(null));
    req.on("timeout", () => { req.destroy(); done(null); });
  });
}

// Open browser
function openBrowser(url) {
  const platform = process.platform;
  let cmd;

  if (platform === "darwin") {
    cmd = `open "${url}"`;
  } else if (platform === "win32") {
    cmd = `start "" "${url}"`;
  } else {
    cmd = `xdg-open "${url}"`;
  }

  exec(cmd, { windowsHide: true }, (err) => {
    if (err) {
      console.log(`Open browser manually: ${url}`);
    }
  });
}

// Find standalone server (bundled in bin/app for published package).
// Prefer custom-server.js (injects real socket IP) when present.
const standaloneDir = path.join(__dirname, "app");
const customServerPath = path.join(standaloneDir, "custom-server.js");
const serverPath = fs.existsSync(customServerPath)
  ? customServerPath
  : path.join(standaloneDir, "server.js");

if (!fs.existsSync(serverPath)) {
  console.error("Error: Standalone build not found.");
  console.error("Please run 'npm run build:cli' first.");
  process.exit(1);
}

// Older macOS LaunchAgents logged the setup token to world-readable /tmp.
try { migrateMacLogs(); } catch { }

// Start server immediately; run update check in parallel (not on the critical path).
const updatePromise = checkForUpdate();
// One launcher per DATA_DIR, and it only manages the server it spawns.
acquireDataDirLock(getDataDir()).then((lock) => {
  if (!lock.ok) {
    const holder = lock.holder ? ` (PID ${lock.holder.pid})` : "";
    if (lock.unknown) {
      console.error(`\n❌ ${lock.file} names a launcher${holder} that 10router can't check, so it may still be running.`);
    } else {
      console.error(`\n❌ Another 10router launcher${holder} is already using ${getDataDir()}.`);
    }
    console.error(`   Quit it first (tray icon → Quit), or give this one its own DATA_DIR.`);
    console.error(`   If no 10router is running, delete ${lock.file} and try again.`);
    process.exit(1);
  }
  process.on("exit", lock.release);
  startServer(updatePromise, lock);
});

// Show interface selection menu
async function showInterfaceMenu(latestVersion) {
  const { selectMenu } = require("./src/cli/utils/input");
  const { clearScreen } = require("./src/cli/utils/display");
  const { getEndpoint } = require("./src/cli/utils/endpoint");

  clearScreen();

  const displayHost = getDisplayHost();

  // Detect tunnel/local mode for server URL display
  let serverUrl;
  try {
    const { endpoint, tunnelEnabled } = await getEndpoint(port);
    serverUrl = tunnelEnabled ? endpoint.replace(/\/v1$/, "") : `http://${displayHost}:${port}`;
  } catch (e) {
    serverUrl = `http://${displayHost}:${port}`;
  }

  const subtitle = `🚀 Server: \x1b[32m${serverUrl}\x1b[0m`;

  const menuItems = [];

  if (latestVersion) {
    menuItems.push({ label: `Update to v${latestVersion} (current: v${pkg.version})`, icon: "⬆" });
  }

  menuItems.push(
    { label: "Web UI (Open in Browser)", icon: "🌐" },
    { label: "Terminal UI (Interactive CLI)", icon: "💻" },
    { label: "Hide to Tray (Background)", icon: "🔔" },
    { label: "Exit", icon: "🚪" }
  );

  // The redraw clears the screen, so keep the setup token on it until setup
  // consumes the token file (src/lib/auth/setupToken.js) or the token expires.
  const setupPending = setupBanner && setupTokenLive(path.join(getDataDir(), "setup-token.json"));
  const selected = await selectMenu(`Choose Interface (v${pkg.version})`, menuItems, 0, subtitle, setupPending ? setupBanner : "");

  const offset = latestVersion ? 1 : 0;

  if (latestVersion && selected === 0) return "update";
  if (selected === offset) return "web";
  if (selected === offset + 1) return "terminal";
  if (selected === offset + 2) return "hide";
  return "exit";
}

function startServer(updatePromise, lock) {
  // Accept either a Promise (parallel update check) or a resolved value.
  const latestVersionPromise = Promise.resolve(updatePromise);
  const displayHost = getDisplayHost();
  const url = `http://${displayHost}:${port}/dashboard`;
  // Surface real network exposure when bound to all interfaces (default 0.0.0.0).
  if (host === DEFAULT_HOST) {
    const lanIp = getLanIp();
    if (lanIp) console.log(`\x1b[33m⚠ Network-exposed: reachable at http://${lanIp}:${port} (bound 0.0.0.0). Use --host 127.0.0.1 for local-only.\x1b[0m`);
  }

  // What an autostart entry or a tray relaunch must start again.
  const autostartLaunch = { port, host, dataDir: process.env.DATA_DIR || "" };

  const CRASH_LOG_LINES = 50;
  let crashLog = [];
  function remember(line) {
    crashLog.push(line);
    if (crashLog.length > CRASH_LOG_LINES) crashLog = crashLog.slice(-CRASH_LOG_LINES);
  }

  // Proves to the readiness check that the server answering is ours.
  const launchNonce = newLaunchNonce();
  const tokenFile = path.join(getDataDir(), "setup-token.json");
  const showBanner = bannerToStdout({ trayMode, autostart: process.env[AUTOSTART_ENV] === "1", legacyLog: writesToLegacyLog() });

  function spawnServer() {
    crashLog = [];
    const child = spawn(RUNTIME, ["--dns-result-order=ipv4first", "--max-old-space-size=6144", serverPath], {
      cwd: standaloneDir,
      stdio: serverStdio(showLog),
      detached: true,
      windowsHide: true,
      env: {
        ...buildEnvWithRuntime(process.env),
        ...launcherEnv(),
        [LAUNCH_NONCE_ENV]: launchNonce,
        PORT: port.toString(),
        HOSTNAME: host
      }
    });
    if (!showLog) {
      // Only the setup token reaches the terminal (or a LaunchAgent log);
      // request lines would land on the menu. On Linux tray/autostart runs
      // the token stays out of stdout; it is in the owner-only token file.
      attachServerOutput(child, {
        show: showBanner ? (line) => console.log(line) : () => {},
        log: remember,
        onBanner: (text) => {
          setupBanner = text;
          if (!showBanner) console.log(`🔑 First-run setup: open /setup and paste the token from ${tokenFile} (only you can read it).`);
        },
      });
    }
    return child;
  }

  function printCrashLog() {
    if (!crashLog.length) return;
    console.error("\n--- Server crash log ---");
    crashLog.forEach(l => console.error(l));
    console.error("--- End crash log ---\n");
  }

  // Suppress all errors during shutdown (systray lib throws JSON parse errors)
  let isShuttingDown = false;
  let isCleaningUp = false;

  // Stop the tray, the tunnel named in the PID file, and our server.
  function cleanup({ killPidFileTunnel = true } = {}) {
    if (isCleaningUp) return;
    isCleaningUp = true;
    try {
      const { killTray } = require("./src/cli/tray/tray");
      killTray();
    } catch (e) { }
    if (killPidFileTunnel) {
      try { killTunnelByPidFile(); } catch { }
    }
    killServer(supervisor.current());
  }

  // Readiness is checked again after every (re)start, and the API client
  // (menu, tray, Terminal UI) waits for it, so the CLI token only ever goes to
  // a server that proved it holds launchNonce.
  const READY_TIMEOUT_MS = 120000;
  // Closed from now until the first child proves itself, and again from each
  // crash until the respawned child does (createReadinessGate).
  const gate = createReadinessGate((promise) => api.pauseUntil(promise));
  const firstReady = gate.ended();
  const serverReady = () => firstReady;

  const supervisor = superviseServer({
    spawn: spawnServer,
    // Before every start: the DATA_DIR lock must still be ours (a takeover
    // race can replace it), and the port must be free.
    preflight: () => (lock.stillHeld()
      ? checkPortFree({ host, dialHost, port })
      : Promise.resolve(Object.assign(new Error(`another 10router launcher replaced ${lock.file}`), { code: "ELOCKLOST" }))),
    onStart: () => gate.started(ownServerReady()),
    isShuttingDown: () => isShuttingDown,
    onExit: (code) => process.exit(code),
    onRestart: ({ code, error, delay, attempt, maxRestarts }) => {
      gate.ended();
      if (error) console.error("Failed to start server:", error.message);
      console.error(`\n⚠️  Server exited (code=${code ?? "unknown"}). Restarting in ${delay / 1000}s... (${attempt}/${maxRestarts})`);
      printCrashLog();
    },
    onGiveUp: ({ reason, error, maxRestarts }) => {
      gate.failed();
      printCrashLog();
      if (error?.code === "ELOCKLOST") {
        console.error(`\n❌ Stopping: ${error.message}, so it may be running on this data directory.`);
      } else if (reason === "port-taken") {
        console.error(`\n❌ Can't start the server on ${host}:${port}: ${error.message}.`);
        console.error(`   Stop the program using port ${port}, or start 10router on another port: ${APP_NAME} --port <port>`);
      } else if (reason === "start-failed") {
        console.error(`\n❌ Failed to start the server: ${error?.message || error}`);
      } else {
        if (error) console.error("Failed to start server:", error.message);
        console.error(`\n❌ The server exited ${maxRestarts + 1} times in a row right after starting, so 10router stopped.`);
        console.error(`   The crash log is above. Run ${APP_NAME} --log to see all server output.`);
      }
      isShuttingDown = true;
      // After a crash, the tunnel in the PID file is our server's leftover.
      // After a port conflict it may belong to whatever holds the port.
      cleanup({ killPidFileTunnel: reason === "crash" });
      process.exit(1);
    },
  });
  // Every exit path, including ones that skip cleanup(), stops our server.
  process.on("exit", () => killServer(supervisor.current()));
  supervisor.start();

  // Resolves true once our own server answers and proves the nonce. Gives up
  // after two minutes with a message, so a server that never listens doesn't
  // leave the launcher (and a tray with no Quit yet) hanging.
  async function ownServerReady() {
    const status = await waitServerReady({
      isAlive: () => !hasExited(supervisor.current()),
      isStopped: () => isShuttingDown,
      isOurs: () => provesLaunchNonce({ host: dialHost, port, nonce: launchNonce }),
      timeoutMs: READY_TIMEOUT_MS,
      onWaiting: (ms) => console.log(`⏳ Still waiting for the server to answer on ${dialHost}:${port} (${Math.round(ms / 1000)}s)...`),
    });
    if (status !== "timeout") return status === "ready";
    printCrashLog();
    console.error(`\n❌ The server didn't answer on ${dialHost}:${port} within ${READY_TIMEOUT_MS / 1000}s, so 10router stopped.`);
    console.error(`   Run ${APP_NAME} --log to see what the server is doing.`);
    isShuttingDown = true;
    cleanup();
    process.exit(1);
  }

  process.on("uncaughtException", (err) => {
    if (isShuttingDown) return;
    console.error("Error:", err.message);
  });

  // Handle all exit scenarios
  process.on("SIGINT", () => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log("\nExiting...");
    cleanup();
    setTimeout(() => process.exit(0), 100);
  });
  process.on("SIGTERM", () => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    cleanup();
    setTimeout(() => process.exit(0), 100);
  });
  process.on("SIGHUP", () => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    cleanup();
    setTimeout(() => process.exit(0), 100);
  });

  // Initialize tray icon (runs alongside TUI)
  const initTrayIcon = () => {
    try {
      const { initTray } = require("./src/cli/tray/tray");
      initTray({
        port,
        cliPath: __filename,
        autostart: autostartLaunch,
        onQuit: () => {
          isShuttingDown = true;
          console.log("\n👋 Shutting down from tray...");
          cleanup();
          setTimeout(() => process.exit(0), 100);
        },
        onOpenDashboard: () => openBrowser(url)
      });
    } catch (err) {
      // Tray not available - continue without it
    }
  };

  // Tray-only mode: no TUI, just tray icon
  if (trayMode) {
    // Ignore SIGHUP so macOS terminal close doesn't kill the background tray process
    process.removeAllListeners("SIGHUP");
    process.on("SIGHUP", () => {});

    console.log(`\n🚀 ${pkg.name} v${pkg.version}`);
    console.log(`Server: http://${displayHost}:${port}`);

    serverReady().then((ready) => {
      if (!ready) return;
      initTrayIcon();
      console.log("\n💡 Router is now running in system tray. Close this terminal if you want.");
      console.log("   Right-click tray icon to open dashboard or quit.\n");
    });

    return;
  }

  // Wait for server to be ready, then show interface menu loop + tray
  // The menu asks the server for its tunnel status with the CLI token, so it
  // waits for our own server, never just any listener on the port.
  serverReady().then(async (ready) => {
    if (!ready) return;
    // Resolve parallel update check (already running); don't block server start on it.
    const latestVersion = await latestVersionPromise;
    // Start tray icon alongside TUI
    initTrayIcon();

    try {
      while (true) {
        const choice = await showInterfaceMenu(latestVersion);

        if (choice === "update") {
          isShuttingDown = true;
          const { clearScreen } = require("./src/cli/utils/display");
          clearScreen();
          console.log(`\n⬆  Update v${pkg.version} → v${latestVersion}\n`);
          console.log(`Run this after exit:\n`);
          console.log(`   \x1b[33m${INSTALL_CMD_LATEST}\x1b[0m\n`);
          cleanup();
          setTimeout(() => process.exit(0), 200);
          return;
        } else if (choice === "web") {
          openBrowser(url);
          // Wait for user to come back
          const { pause } = require("./src/cli/utils/input");
          await pause("\nPress Enter to go back to menu...");
        } else if (choice === "terminal") {
          // Start Terminal UI - it will return when user selects Back
          const { startTerminalUI } = require("./src/cli/terminalUI");
          await startTerminalUI(port);
          // Loop continues, show menu again
        } else if (choice === "hide") {
          const { clearScreen } = require("./src/cli/utils/display");
          clearScreen();

          // Enable auto startup on OS boot
          try {
            const { enableAutoStart } = require("./src/cli/tray/autostart");
            enableAutoStart(__filename, autostartLaunch);
          } catch (e) { }

          if (process.platform === "darwin") {
            // macOS: keep current process alive — spawning a detached child puts
            // it outside the login session so NSStatusItem silently fails.
            process.removeAllListeners("SIGHUP");
            process.on("SIGHUP", () => {});

            console.log(`\n⏳ Switching to tray mode... (icon already visible in menu bar)`);
            console.log(`🔔 10router is running in tray (PID: ${process.pid})`);
            console.log(`   Server: http://${displayHost}:${port}`);
            console.log(`\n💡 You can close this terminal. Right-click tray icon to quit.\n`);

            // Tray already init'd at startup — just keep event loop alive.
            return;
          }

          // Windows/Linux: spawn detached bgProcess (systray works fine in child)
          console.log(`\n⏳ Starting background process... (tray icon will appear in ~3s)`);

          // Hand over cleanly: stop our server and tray and release the
          // DATA_DIR lock before bgProcess starts, so it finds the port free
          // and the lock open however long the cleanup took.
          isShuttingDown = true;
          cleanup();
          lock.release();

          const bgProcess = spawn(process.execPath, ["--dns-result-order=ipv4first", __filename, ...getBackgroundArgs({ port, host })], {
            detached: true,
            stdio: "ignore",
            windowsHide: true,
            env: { ...process.env }
          });
          bgProcess.unref();

          console.log(`🔔 10router is now running in background (PID: ${bgProcess.pid})`);
          console.log(`   Server: http://${displayHost}:${port}`);
          console.log(`\n💡 You can close this terminal. Right-click tray icon to quit.\n`);
          process.exit(0);
        } else if (choice === "exit") {
          isShuttingDown = true;
          console.log("\nExiting...");
          cleanup();
          setTimeout(() => process.exit(0), 100);
        }
      }
    } catch (err) {
      console.error("Error:", err.message);
      cleanup();
      process.exit(1);
    }
  });
}
