import crypto from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const CURRENT_SALT = "10router-host-credentials";

function deriveKey(salt) {
  const identity = require("node-machine-id").machineIdSync();
  if (!identity) throw new Error("Machine identity is unavailable for host credential encryption");
  return crypto.createHash("sha256").update(identity + salt).digest();
}

export function encryptHostPassword(password) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", deriveKey(CURRENT_SALT), iv);
  const data = Buffer.concat([cipher.update(password, "utf8"), cipher.final()]);
  return `${iv.toString("hex")}:${cipher.getAuthTag().toString("hex")}:${data.toString("hex")}`;
}

export function decryptHostPassword(stored, salt = CURRENT_SALT) {
  try {
    const [iv, tag, data] = stored.split(":").map((part) => Buffer.from(part, "hex"));
    const decipher = crypto.createDecipheriv("aes-256-gcm", deriveKey(salt), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
  } catch { return ""; }
}

export function migrateLegacyHostPassword(db, settings, { cleanup = true } = {}) {
  const password = decryptHostPassword(settings?.mitmSudoEncrypted, "10router-mitm-pwd");
  if (!password) return;
  const encrypted = JSON.stringify(encryptHostPassword(password));
  // Cleanup needs the old elevation credential only until its first successful run.
  if (cleanup) db.run("INSERT OR IGNORE INTO kv(scope, key, value) VALUES('hostCredentials', 'retiredProxy', ?)", [encrypted]);
  if (settings.tailscaleEnabled || settings.tailscaleUrl) {
    db.run("INSERT OR IGNORE INTO kv(scope, key, value) VALUES('hostCredentials', 'tailscale', ?)", [encrypted]);
  }
}
