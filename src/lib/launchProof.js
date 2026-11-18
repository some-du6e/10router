import crypto from "node:crypto";

// The CLI launcher hands its server a random TENROUTER_LAUNCH_NONCE and, before
// it sends the CLI token anywhere, asks /api/health with a fresh challenge. Only
// a process holding the nonce can answer with HMAC-SHA256(nonce, challenge), so
// whatever else might answer on the port can't pass for the launcher's server.
// The nonce itself never leaves the process. cli/src/cli/utils/serverProcess.js
// holds the other half; tests/unit/cli-launcher-lifecycle.test.js checks both.
export const LAUNCH_NONCE_ENV = "TENROUTER_LAUNCH_NONCE";
export const LAUNCH_CHALLENGE_HEADER = "x-9r-launch-challenge";
export const LAUNCH_PROOF_HEADER = "x-9r-launch-proof";

export function launchProof(nonce, challenge) {
  return crypto.createHmac("sha256", nonce).update(challenge).digest("hex");
}

// The proof header for a health request, or null when there is nothing to prove.
export function launchProofFor(challenge, env = process.env) {
  const nonce = env[LAUNCH_NONCE_ENV];
  if (!nonce || typeof challenge !== "string" || !/^[0-9a-f]{32}$/.test(challenge)) return null;
  return launchProof(nonce, challenge);
}
