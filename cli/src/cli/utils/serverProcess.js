// The launcher's view of its own server child: is it still running, stop it,
// is its port free before we start, and is it the one answering.
const net = require("net");
const http = require("http");
const crypto = require("crypto");
const { execFileSync } = require("child_process");

// The launcher's half of src/lib/launchProof.js: the server gets a random
// nonce in its env and proves it holds it by answering a fresh challenge on
// /api/health with HMAC-SHA256(nonce, challenge|peer host|peer port|salt). The
// peer is this connection as the server saw it, which the launcher knows as
// its own socket's local address and port, so a relayed proof doesn't match.
const LAUNCH_NONCE_ENV = "TENROUTER_LAUNCH_NONCE";
const LAUNCH_CHALLENGE_HEADER = "x-9r-launch-challenge";
const LAUNCH_PROOF_HEADER = "x-9r-launch-proof";
const LAUNCH_SALT_HEADER = "x-9r-launch-salt";

function newLaunchNonce() {
  return crypto.randomBytes(32).toString("hex");
}

// An IPv4 peer on a dual-stack socket shows as ::ffff:a.b.c.d.
function normalizePeerHost(host) {
  return String(host || "").replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, "");
}

function launchProof(nonce, challenge, peerHost, peerPort, salt) {
  return crypto.createHmac("sha256", nonce)
    .update(`${challenge}|${normalizePeerHost(peerHost)}|${peerPort}|${salt}`)
    .digest("hex");
}

// True only when whatever answers on host:port proves it holds `nonce`, for
// this very connection.
function provesLaunchNonce({ host, port, nonce, request = http.request, timeoutMs = 2000 }) {
  const challenge = crypto.randomBytes(16).toString("hex");
  return new Promise((resolve) => {
    let settled = false;
    let socket = null;
    const done = (value) => { if (!settled) { settled = true; resolve(value); } };
    const req = request({ host, port, path: "/api/health", method: "GET", agent: false, headers: { [LAUNCH_CHALLENGE_HEADER]: challenge } }, (res) => {
      res.resume();
      const salt = String(res.headers?.[LAUNCH_SALT_HEADER] || "");
      const proof = Buffer.from(String(res.headers?.[LAUNCH_PROOF_HEADER] || ""));
      const local = socket || res.socket;
      if (!salt || !local?.localAddress || !local.localPort) return done(false);
      const expected = Buffer.from(launchProof(nonce, challenge, local.localAddress, local.localPort, salt));
      done(proof.length === expected.length && crypto.timingSafeEqual(proof, expected));
    });
    req.on("socket", (s) => { socket = s; });
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

// Keeps the API client's gate closed whenever there is no proven server: from
// the start, and from the moment a child exits until the next child's
// readiness passes. Without that, a request sent between a crash and the
// respawn would pass the previous child's (already resolved) check and could
// reach whatever took the port in between.
//   ended()   a child exited (or none started yet): close the gate until the
//             next started(); returns the promise the gate now waits for
//   started() a child was spawned: the gate follows its readiness check
//   failed()  no next child is coming (give-up): the gate resolves false
function createReadinessGate(setGate) {
  let next = null;
  let resolveNext = null;
  return {
    ended() {
      if (!next) {
        next = new Promise((resolve) => { resolveNext = resolve; });
        setGate(next);
      }
      return next;
    },
    started(readiness) {
      setGate(readiness);
      if (resolveNext) resolveNext(readiness);
      next = resolveNext = null;
    },
    failed() {
      if (resolveNext) resolveNext(false);
      else setGate(Promise.resolve(false));
      next = resolveNext = null;
    },
  };
}

module.exports = {
  hasExited, killServer, checkPortFree, waitServerReady,
  newLaunchNonce, launchProof, provesLaunchNonce, createReadinessGate,
  LAUNCH_NONCE_ENV, LAUNCH_CHALLENGE_HEADER, LAUNCH_PROOF_HEADER, LAUNCH_SALT_HEADER,
};
