import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DATA_DIR } from "../dataDir.js";

// The server secret that signs dashboard sessions and SAML request state:
// JWT_SECRET, else one generated once into $DATA_DIR/jwt-secret.
let cached = null;

const MIN_JWT_SECRET_LENGTH = 32;
// Every JWT_SECRET example value the docs and env templates ever shipped. Anyone
// can sign a session with one of these, so they count as no secret at all.
const PLACEHOLDER_JWT_SECRETS = new Set([
  "change-me-to-a-long-random-secret",
  "your-secure-secret",
  "your-secret",
  "your-secure-secret-change-this",
  "your-secure-secret-change-this-to-random-string",
  "generated-secret-here",
  "tu-secreto-seguro-cámbialo",
  "votre-secret-sécurisé-changez-le",
]);

export function isUsableJwtSecret(value) {
  return (
    typeof value === "string" &&
    value.trim().length >= MIN_JWT_SECRET_LENGTH &&
    !PLACEHOLDER_JWT_SECRETS.has(value.trim())
  );
}

// JWT_SECRET when it is strong enough, else null (with a warning when it was set).
function envSecret() {
  const fromEnv = process.env.JWT_SECRET;
  if (isUsableJwtSecret(fromEnv)) return fromEnv;
  if (fromEnv) {
    console.warn(
      `[auth] Ignoring JWT_SECRET: it is a documented placeholder or shorter than ${MIN_JWT_SECRET_LENGTH} characters. ` +
        "Using the generated secret in the data directory instead. Generate one with: openssl rand -hex 32"
    );
  }
  return null;
}

// A file this young that reads empty may still be getting its bytes (the copy
// fallback below creates it before writing), so it is read again for a moment.
const SETTLE_MS = 2000;

function pause(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// The trimmed secret, "" for a file that stays empty, null when there is no file.
function readSecret(file) {
  const deadline = Date.now() + SETTLE_MS;
  for (;;) {
    let content;
    let stat;
    try {
      content = fs.readFileSync(file, "utf8").trim();
      if (content) return content;
      stat = fs.statSync(file);
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
    if (Date.now() - stat.mtimeMs > SETTLE_MS || Date.now() > deadline) return "";
    pause(20);
  }
}

function emptyFileError(file) {
  return new Error(`${file} is empty. Delete it to generate a new secret, or set JWT_SECRET (at least ${MIN_JWT_SECRET_LENGTH} characters).`);
}

export function getAuthSecret() {
  if (cached) return cached;
  const fromEnv = envSecret();
  if (fromEnv) return (cached = fromEnv);
  const file = path.join(DATA_DIR, "jwt-secret");
  const stored = readSecret(file);
  if (stored) return (cached = stored);
  if (stored === "") throw emptyFileError(file);

  // Write the whole secret to a private temp file, then publish it under the real
  // name. With a hard link the file is never seen half-written; with the copy
  // fallback, a reader that finds it empty waits for the bytes. When two module
  // graphs or processes start at once, the first to publish wins and the other
  // reads its secret.
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const generated = crypto.randomBytes(32).toString("hex");
  const tmp = path.join(DATA_DIR, `.jwt-secret.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`);
  fs.writeFileSync(tmp, generated, { mode: 0o600, flag: "wx" });
  try {
    try {
      fs.linkSync(tmp, file);
    } catch (error) {
      if (error?.code === "EEXIST") throw error;
      // No hard links here (FAT, exFAT, some network and FUSE mounts, each with its
      // own error code): copy exclusively instead. copyFileSync keeps the temp
      // file's 0600 mode; a reader that catches it empty waits (readSecret).
      fs.copyFileSync(tmp, file, fs.constants.COPYFILE_EXCL);
    }
    return (cached = generated);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const winner = readSecret(file);
    if (winner) return (cached = winner);
    throw emptyFileError(file);
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {}
  }
}
