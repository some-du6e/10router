#!/usr/bin/env node

const { spawn, exec, execSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const https = require("https");
const net = require("net");
const os = require("os");

// Poll until the server accepts TCP connections on port, or timeout — avoids blind fixed waits.
function waitServerReady(port, { timeoutMs = 15000, intervalMs = 150 } = {}) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const tryConnect = () => {
      const socket = net.connect({ host: "127.0.0.1", port }, () => {
        socket.destroy();
        resolve(true);
      });
      socket.on("error", () => {
        socket.destroy();
        if (Date.now() >= deadline) return resolve(false);
        setTimeout(tryConnect, intervalMs);
      });
    };
    tryConnect();
  });
}

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
const { ensureSqliteRuntime, buildEnvWithRuntime } = require("./hooks/sqliteRuntime");
const { ensureTrayRuntime } = require("./hooks/trayRuntime");
const { getBackgroundArgs } = require("./src/cli/utils/launchArgs");
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

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--port" || args[i] === "-p") {
    port = parseInt(args[i + 1], 10) || DEFAULT_PORT;
    i++;
  } else if (args[i] === "--host" || args[i] === "-H") {
    host = args[i + 1] || DEFAULT_HOST;
    i++;
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
  -l, --log           Show server logs (default: hidden)
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

// Get app data dir (matches app/src/lib/dataDir.js convention).
// NOTE: the ".9router" / "9router" directory names are retained for compatibility
// with existing installs — deliberately NOT renamed during the 10router rebrand.
function getAppDataDir() {
  return process.platform === "win32"
    ? path.join(process.env.APPDATA || "", "9router")
    : path.join(os.homedir(), ".9router");
}

// Kill PID from file (best-effort, removes file after)
function killByPidFile(pidFile) {
  try {
    if (!fs.existsSync(pidFile)) return;
    const pid = parseInt(fs.readFileSync(pidFile, "utf8").trim(), 10);
    if (!pid) return;
    try {
      if (process.platform === "win32") {
        execSync(`taskkill /F /T /PID ${pid}`, { stdio: "ignore", windowsHide: true, timeout: 3000 });
      } else {
        process.kill(pid, "SIGKILL");
      }
    } catch { }
    try { fs.unlinkSync(pidFile); } catch { }
  } catch { }
}

// Kill tunnel processes (cloudflared/tailscale) by their PID files
function killTunnelByPidFile() {
  const tunnelDir = path.join(getAppDataDir(), "tunnel");
  killByPidFile(path.join(tunnelDir, "cloudflared.pid"));
  killByPidFile(path.join(tunnelDir, "tailscale.pid"));
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

// Start server immediately; run update check in parallel (not on the critical path).
const updatePromise = checkForUpdate();
// Only manage the child we spawn. An occupied port belongs to its existing owner.
startServer(updatePromise);

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

  const selected = await selectMenu(`Choose Interface (v${pkg.version})`, menuItems, 0, subtitle);

  const offset = latestVersion ? 1 : 0;

  if (latestVersion && selected === 0) return "update";
  if (selected === offset) return "web";
  if (selected === offset + 1) return "terminal";
  if (selected === offset + 2) return "hide";
  return "exit";
}

const MAX_RESTARTS = 2;
const RESTART_RESET_MS = 30000; // Reset counter if alive > 30s

function startServer(updatePromise) {
  // Accept either a Promise (parallel update check) or a resolved value.
  const latestVersionPromise = Promise.resolve(updatePromise);
  const displayHost = getDisplayHost();
  const url = `http://${displayHost}:${port}/dashboard`;
  // Surface real network exposure when bound to all interfaces (default 0.0.0.0).
  if (host === DEFAULT_HOST) {
    const lanIp = getLanIp();
    if (lanIp) console.log(`\x1b[33m⚠ Network-exposed: reachable at http://${lanIp}:${port} (bound 0.0.0.0). Use --host 127.0.0.1 for local-only.\x1b[0m`);
  }

  let restartCount = 0;
  let serverStartTime = Date.now();

  const CRASH_LOG_LINES = 50;
  let crashLog = [];

  function spawnServer() {
    serverStartTime = Date.now();
    crashLog = [];
    const child = spawn(RUNTIME, ["--dns-result-order=ipv4first", "--max-old-space-size=6144", serverPath], {
      cwd: standaloneDir,
      stdio: showLog ? "inherit" : ["ignore", "ignore", "pipe"],
      detached: true,
      windowsHide: true,
      env: {
        ...buildEnvWithRuntime(process.env),
        PORT: port.toString(),
        HOSTNAME: host
      }
    });
    if (!showLog && child.stderr) {
      child.stderr.on("data", (data) => {
        const lines = data.toString().split("\n").filter(Boolean);
        crashLog.push(...lines);
        if (crashLog.length > CRASH_LOG_LINES) crashLog = crashLog.slice(-CRASH_LOG_LINES);
      });
    }
    return child;
  }

  let server = spawnServer();

  // Cleanup function - force kill server process
  let isCleaningUp = false;
  function cleanup() {
    if (isCleaningUp) return;
    isCleaningUp = true;
    try {
      // Kill tray if running
      try {
        const { killTray } = require("./src/cli/tray/tray");
        killTray();
      } catch (e) { }
      // Kill cloudflared/tailscale via PID file (only this app's tunnel)
      killTunnelByPidFile();
      // Kill server process directly
      if (server.pid) {
        process.kill(server.pid, "SIGKILL");
      }
      // Also try to kill process group
      process.kill(-server.pid, "SIGKILL");
    } catch (e) { }
  }

  // Suppress all errors during shutdown (systray lib throws JSON parse errors)
  let isShuttingDown = false;
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
        host,
        cliPath: __filename,
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

  attachServerEvents();

  // Tray-only mode: no TUI, just tray icon
  if (trayMode) {
    // Ignore SIGHUP so macOS terminal close doesn't kill the background tray process
    process.removeAllListeners("SIGHUP");
    process.on("SIGHUP", () => {});

    console.log(`\n🚀 ${pkg.name} v${pkg.version}`);
    console.log(`Server: http://${displayHost}:${port}`);

    waitServerReady(port).then(() => {
      initTrayIcon();
      console.log("\n💡 Router is now running in system tray. Close this terminal if you want.");
      console.log("   Right-click tray icon to open dashboard or quit.\n");
    });

    return;
  }

  // Wait for server to be ready, then show interface menu loop + tray
  waitServerReady(port).then(async () => {
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
            enableAutoStart(__filename, { port, host });
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

          // cleanup() kills server so bgProcess can claim the port fresh
          cleanup();
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

  function attachServerEvents() {
    // A failed spawn emits both error and close. Schedule recovery only once.
    let failed = false;
    server.on("error", (err) => {
      if (failed) return;
      failed = true;
      console.error("Failed to start server:", err.message);
      if (!isShuttingDown) tryRestart();
      else { cleanup(); process.exit(1); }
    });

    server.on("close", (code) => {
      if (failed) return;
      failed = true;
      if (isShuttingDown || code === 0) {
        process.exit(code || 0);
        return;
      }
      tryRestart(code);
    });
  }

  function tryRestart(code) {
    const aliveMs = Date.now() - serverStartTime;
    // Reset counter if last run was stable
    if (aliveMs >= RESTART_RESET_MS) restartCount = 0;

    if (restartCount >= MAX_RESTARTS) {
      console.error(`Server failed after ${MAX_RESTARTS} restarts. Check the port and server crash log above.`);
      isShuttingDown = true;
      cleanup();
      process.exit(1);
      return;
    }

    restartCount++;
    const delay = Math.min(1000 * restartCount, 10000);
    console.error(`\n⚠️  Server exited (code=${code ?? "unknown"}). Restarting in ${delay / 1000}s... (${restartCount}/${MAX_RESTARTS})`);
    if (crashLog.length) {
      console.error("\n--- Server crash log ---");
      crashLog.forEach(l => console.error(l));
      console.error("--- End crash log ---\n");
    }

    setTimeout(() => {
      if (isShuttingDown) return;
      server = spawnServer();
      attachServerEvents();
    }, delay);
  }

}
