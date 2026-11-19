import crypto from "node:crypto";

// The CLI launcher hands its server a random TENROUTER_LAUNCH_NONCE and, before
// it sends the CLI token anywhere, asks /api/health with a fresh challenge. The
// server answers HMAC-SHA256(nonce, challenge|peer host|peer port|salt), where
// the peer is the TCP connection custom-server.js stamped (x-9r-real-ip,
// x-9r-real-port) and the salt is fresh per answer. So a process that relays
// the challenge to the real server over its own connection gets a proof for
// the wrong peer, and answers from /api/health can't be correlated.
// cli/src/cli/utils/serverProcess.js holds the other half;
// tests/unit/launch-proof.test.js checks both.
export const LAUNCH_NONCE_ENV = "TENROUTER_LAUNCH_NONCE";
export const LAUNCH_CHALLENGE_HEADER = "x-9r-launch-challenge";
export const LAUNCH_PROOF_HEADER = "x-9r-launch-proof";
export const LAUNCH_SALT_HEADER = "x-9r-launch-salt";
const NONCE_KEY = Symbol.for("10router.launchNonce");

// custom-server.js moves the nonce here at boot and deletes it from the env,
// so cloudflared, tailscale and the updater (which inherit the env) never get
// it. Without custom-server, the first import of this module does the same.
export function takeLaunchNonce(env = process.env) {
  if (globalThis[NONCE_KEY] === undefined) globalThis[NONCE_KEY] = env[LAUNCH_NONCE_ENV] || null;
  delete env[LAUNCH_NONCE_ENV];
  return globalThis[NONCE_KEY];
}
takeLaunchNonce();

// An IPv4 peer on a dual-stack socket shows as ::ffff:a.b.c.d.
export function normalizePeerHost(host) {
  return String(host || "").replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, "");
}

export function launchProof(nonce, challenge, peerHost, peerPort, salt) {
  return crypto.createHmac("sha256", nonce)
    .update(`${challenge}|${normalizePeerHost(peerHost)}|${peerPort}|${salt}`)
    .digest("hex");
}

// The salt and proof headers for one health request, or null when there is
// nothing to prove (no nonce, a malformed challenge, no stamped peer).
export function launchProofHeaders({ challenge, peerHost, peerPort, nonce = takeLaunchNonce() }) {
  if (!nonce || typeof challenge !== "string" || !/^[0-9a-f]{32}$/.test(challenge)) return null;
  if (!peerHost || !/^\d+$/.test(String(peerPort ?? ""))) return null;
  const salt = crypto.randomBytes(16).toString("hex");
  return { [LAUNCH_SALT_HEADER]: salt, [LAUNCH_PROOF_HEADER]: launchProof(nonce, challenge, peerHost, peerPort, salt) };
}
