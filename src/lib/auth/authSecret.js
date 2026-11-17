import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DATA_DIR } from "../dataDir.js";

// The server secret that signs dashboard sessions and SAML request state:
// JWT_SECRET, else one generated once into $DATA_DIR/jwt-secret.
let cached = null;

function readSecret(file) {
  try {
    return fs.readFileSync(file, "utf8").trim();
  } catch (error) {
    if (error?.code === "ENOENT") return "";
    throw error;
  }
}

function pause(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function getAuthSecret() {
  if (cached) return cached;
  if (process.env.JWT_SECRET) return (cached = process.env.JWT_SECRET);
  const file = path.join(DATA_DIR, "jwt-secret");
  const stored = readSecret(file);
  if (stored) return (cached = stored);

  fs.mkdirSync(DATA_DIR, { recursive: true });
  const generated = crypto.randomBytes(32).toString("hex");
  try {
    // "wx": only one writer creates the file, so two module graphs or processes
    // starting at once can't each keep a different secret.
    fs.writeFileSync(file, generated, { mode: 0o600, flag: "wx" });
    return (cached = generated);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  // Someone else created it first: use theirs, once they have finished writing it.
  for (let attempt = 0; attempt < 20; attempt++) {
    const winner = readSecret(file);
    if (winner) return (cached = winner);
    pause(10);
  }
  throw new Error(`${file} is empty. Delete it to generate a new secret, or set JWT_SECRET.`);
}
