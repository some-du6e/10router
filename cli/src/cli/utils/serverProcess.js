// The launcher's view of its own server child: is it still running, stop it,
// is its port free before we start, and is it the one answering.
const net = require("net");
const http = require("http");
const crypto = require("crypto");
const { execFileSync } = require("child_process");

// The launcher's half of src/lib/launchProof.js: the server gets a random
// nonce in its env and proves it holds it by answering a fresh challenge on
// /api/health with HMAC-SHA256(nonce, challenge).
const LAUNCH_NONCE_ENV = "TENROUTER_LAUNCH_NONCE";
const LAUNCH_CHALLENGE_HEADER = "x-9r-launch-challenge";
const LAUNCH_PROOF_HEADER = "x-9r-launch-proof";

function newLaunchNonce() {
  return crypto.randomBytes(32).toString("hex");
}

function launchProof(nonce, challenge) {
  return crypto.createHmac("sha256", nonce).update(challenge).digest("hex");
}

// True only when whatever answers on host:port proves it holds `nonce`.
function provesLaunchNonce({ host, port, nonce, request = http.request, timeoutMs = 2000 }) {
  const challenge = crypto.randomBytes(16).toString("hex");
  const expected = Buffer.from(launchProof(nonce, challenge));
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => { if (!settled) { settled = true; resolve(value); } };
    const req = request({ host, port, path: "/api/health", method: "GET", headers: { [LAUNCH_CHALLENGE_HEADER]: challenge } }, (res) => {
      res.resume();
      const proof = Buffer.from(String(res.headers?.[LAUNCH_PROOF_HEADER] || ""));
      done(proof.length === expected.length && crypto.timingSafeEqual(proof, expected));
    });
    req.setTimeout(timeoutMs, () => { req.destroy(); done(false); });
    req.on("error", () => done(false));
    req.end();
  });
}

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

// Resolves "ready" once our own child is alive and the server on its address
// proves it holds the launch nonce (isOurs()). Never "ready" for a dead child
// or for anything else answering on the port, so no occupant gets the CLI
// token. Resolves "stopped" when isStopped() turns true, and "timeout" after
// timeoutMs. onWaiting(elapsedMs) is called every noticeMs while it waits.
function waitServerReady({
  isAlive, isStopped, isOurs,
  timeoutMs = 120000, noticeMs = 15000, onWaiting = () => {},
  intervalMs = 150,
}) {
  const started = Date.now();
  let nextNotice = started + noticeMs;
  return new Promise((resolve) => {
    const retry = () => setTimeout(attempt, intervalMs);
    async function attempt() {
      if (isStopped()) return resolve("stopped");
      const now = Date.now();
      if (now - started >= timeoutMs) return resolve("timeout");
      if (now >= nextNotice) {
        nextNotice += noticeMs;
        onWaiting(now - started);
      }
      if (!isAlive()) return retry();
      const ours = await isOurs().catch(() => false);
      if (ours && isAlive()) resolve("ready");
      else retry();
    }
    attempt();
  });
}

module.exports = {
  hasExited, killServer, checkPortFree, waitServerReady,
  newLaunchNonce, launchProof, provesLaunchNonce,
  LAUNCH_NONCE_ENV, LAUNCH_CHALLENGE_HEADER, LAUNCH_PROOF_HEADER,
};
