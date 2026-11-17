import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DATA_DIR } from "../dataDir.js";

// The server secret that signs dashboard sessions and SAML request state:
// JWT_SECRET, else one generated once into $DATA_DIR/jwt-secret.
let cached = null;

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
  return new Error(`${file} is empty. Delete it to generate a new secret, or set JWT_SECRET.`);
}

export function getAuthSecret() {
  if (cached) return cached;
  if (process.env.JWT_SECRET) return (cached = process.env.JWT_SECRET);
  const file = path.join(DATA_DIR, "jwt-secret");
  const stored = readSecret(file);
  if (stored) return (cached = stored);
  if (stored === "") throw emptyFileError(file);

  // Write the whole secret to a private temp file, then publish it under the real
  // name in one step. The file is never seen half-written, and when two module
  // graphs or processes start at once, the first link wins and the other reads it.
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
