import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const dbRoot = process.env.DB_AUDIT_ROOT || path.resolve(import.meta.dirname, "../../src/lib/db");
const originalDataDir = process.env.DATA_DIR;
let dir;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "db-key-backup-"));
  process.env.DATA_DIR = dir;
  delete global._dbAdapter;
  vi.resetModules();
});

afterEach(() => {
  global._dbAdapter?.instance?.close();
  delete global._dbAdapter;
  fs.rmSync(dir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

const keys = [true, false, null].map((limitHold, index) => ({ id: `key-${index}`, key: `secret-${index}`, limitHold }));

it("preserves true, false and inherited API key hold settings through backup restore", async () => {
  const db = await import(`${dbRoot}/index.js`);
  await db.importDb({ apiKeys: keys });
  const backup = await db.exportDb();
  expect(backup.apiKeys.map((key) => key.limitHold)).toEqual([true, false, null]);
  await db.updateApiKey("key-0", { limitHold: false });
  await db.importDb(backup);
  expect((await db.getApiKeys()).map((key) => key.limitHold)).toEqual([true, false, null]);
});

it("retains API key hold overrides during automatic legacy JSON migration", async () => {
  fs.writeFileSync(path.join(dir, "db.json"), JSON.stringify({ apiKeys: keys }));
  const db = await import(`${dbRoot}/index.js`);
  expect((await db.getApiKeys()).map((key) => key.limitHold)).toEqual([true, false, null]);
});

it("rolls back a failed restore without losing existing settings and keys", async () => {
  const db = await import(`${dbRoot}/index.js`);
  await db.importDb({ settings: { retained: true }, apiKeys: keys });
  await expect(db.importDb({ settings: { retained: false }, apiKeys: [{ id: "bad" }] })).rejects.toThrow();
  expect((await db.getSettings()).retained).toBe(true);
  expect((await db.getApiKeys()).map((key) => key.key)).toEqual(keys.map((key) => key.key));
});
