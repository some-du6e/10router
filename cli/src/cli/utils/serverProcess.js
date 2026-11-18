// The launcher's view of its own server child: is it still running, stop it,
// is its port free before we start, and is it the one answering.
const net = require("net");
const { execFileSync } = require("child_process");

// Once a child has exited and been reaped, its PID can belong to another
// program, so nothing may signal it.
function hasExited(child) {
  return !child || child.exitCode !== null || child.signalCode !== null;
}

function killServer(child, {
  platform = process.platform,
  kill = process.kill.bind(process),
  run = execFileSync,
} = {}) {
  if (!child || !child.pid || hasExited(child)) return false;
  if (platform === "win32") {
    // No process groups on Windows: /T takes the tree, so the cloudflared the
    // server started goes too.
    try { run("taskkill", ["/F", "/T", "/PID", String(child.pid)], { stdio: "ignore", windowsHide: true, timeout: 3000 }); } catch { }
    return true;
  }
  try { kill(child.pid, "SIGKILL"); } catch { }
  // The server is spawned detached, so it leads its own process group, which
  // holds the cloudflared it started.
  try { kill(-child.pid, "SIGKILL"); } catch { }
  return true;
}

function accepts(host, port, { connect = net.connect, timeoutMs = 500 } = {}) {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const done = (value) => { socket.destroy(); resolve(value); };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

function canBind(host, port, { createServer = net.createServer } = {}) {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", (err) => resolve(err));
    server.listen({ host, port, exclusive: true }, () => server.close(() => resolve(null)));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Returns null when the server can start on host:port, else the reason. Two
// checks, because a bind alone can succeed next to another listener: Linux
// allows 127.0.0.1:P beside 192.168.x.y:P, and macOS a specific address
// beside 0.0.0.0:P. So nothing may already answer on the address the launcher
// dials, and the bind must work. Retries cover a server that a tray handoff
// just stopped.
async function checkPortFree({ host, dialHost, port, attempts = 5, delayMs = 400, net: io = net }) {
  let reason = null;
  for (let i = 0; i < attempts; i++) {
    if (await accepts(dialHost, port, { connect: io.connect })) {
      reason = Object.assign(new Error(`another process is already listening on ${dialHost}:${port}`), { code: "EADDRINUSE" });
    } else {
      reason = await canBind(host, port, { createServer: io.createServer });
      if (!reason) return null;
      // Only a busy port can clear up by waiting.
      if (reason.code !== "EADDRINUSE") return reason;
    }
    if (i < attempts - 1) await sleep(delayMs);
  }
  return reason;
}

// Resolves "ready" once our own child is alive and something answers on its
// address. checkPortFree made sure nothing else answered there before the
// child started, so that listener is the child. Never "ready" for a dead
// child, so a port occupant never gets the CLI token. Resolves "stopped" when
// isStopped() turns true, and "timeout" after timeoutMs. onWaiting(elapsedMs)
// is called every noticeMs while it waits.
function waitServerReady({
  dialHost, port, isAlive, isStopped,
  timeoutMs = 120000, noticeMs = 15000, onWaiting = () => {},
  intervalMs = 150, connect = net.connect,
}) {
  const started = Date.now();
  let nextNotice = started + noticeMs;
  return new Promise((resolve) => {
    const retry = () => setTimeout(attempt, intervalMs);
    function attempt() {
      if (isStopped()) return resolve("stopped");
      const now = Date.now();
      if (now - started >= timeoutMs) return resolve("timeout");
      if (now >= nextNotice) {
        nextNotice += noticeMs;
        onWaiting(now - started);
      }
      if (!isAlive()) return retry();
      const socket = connect({ host: dialHost, port }, () => {
        socket.destroy();
        if (isAlive()) resolve("ready");
        else retry();
      });
      socket.once("error", () => { socket.destroy(); retry(); });
    }
    attempt();
  });
}

module.exports = { hasExited, killServer, checkPortFree, waitServerReady };
