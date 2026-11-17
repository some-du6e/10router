import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DATA_DIR } from "../dataDir.js";

// The server secret that signs dashboard sessions and SAML request state:
// JWT_SECRET, else one generated once into $DATA_DIR/jwt-secret.
let cached = null;

export function getAuthSecret() {
  if (cached) return cached;
  if (process.env.JWT_SECRET) return (cached = process.env.JWT_SECRET);
  const file = path.join(DATA_DIR, "jwt-secret");
  try {
    const stored = fs.readFileSync(file, "utf8").trim();
    if (stored) return (cached = stored);
  } catch {}
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const generated = crypto.randomBytes(32).toString("hex");
  fs.writeFileSync(file, generated, { mode: 0o600 });
  return (cached = generated);
}
