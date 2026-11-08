import path from "node:path";
import fs from "node:fs";
import { DATA_DIR } from "@/lib/dataDir.js";

export const DB_DIR = path.join(DATA_DIR, "db");
export const DATA_FILE = path.join(DB_DIR, "data.sqlite");
export const BACKUPS_DIR = path.join(DB_DIR, "backups");
export const LEGACY_FILES = {
  main: path.join(DATA_DIR, "db.json"),
  usage: path.join(DATA_DIR, "usage.json"),
  disabled: path.join(DATA_DIR, "disabledModels.json"),
  details: path.join(DATA_DIR, "request-details.json"),
};
export function ensureDirs() {
  for (const dir of [DATA_DIR, DB_DIR, BACKUPS_DIR]) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  restrictMode(DB_DIR, 0o700);
}

// The database holds provider credentials, so only the owner may read it.
export function restrictDbFilePermissions() {
  for (const file of [DATA_FILE, `${DATA_FILE}-wal`, `${DATA_FILE}-shm`]) restrictMode(file, 0o600);
}

function restrictMode(target, mode) {
  if (process.platform === "win32") return;
  try {
    if ((fs.statSync(target).mode & 0o777) !== mode) fs.chmodSync(target, mode);
  } catch {}
}
