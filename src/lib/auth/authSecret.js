import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DATA_DIR } from "../dataDir.js";

// The server secret that signs dashboard sessions and SAML request state:
// JWT_SECRET, else one generated once into $DATA_DIR/jwt-secret.
let cached = null;

// null when the file doesn't exist.
function readSecret(file) {
  try {
    return fs.readFileSync(file, "utf8").trim();
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function emptyFileError(file) {
  return new Error(`${file} is empty. Delete it to generate a new secret, or set JWT_SECRET.`);
}

// Filesystems without hard links (some network and FUSE mounts).
const NO_HARD_LINKS = new Set(["EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EXDEV"]);

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
      if (!NO_HARD_LINKS.has(error?.code)) throw error;
      fs.copyFileSync(tmp, file, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(file, 0o600);
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
