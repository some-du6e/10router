import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const dbRoot = process.env.DB_AUDIT_ROOT || path.resolve(import.meta.dirname, "../../src/lib/db");
const originalDataDir = process.env.DATA_DIR;
let dir;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "db-import-retry-"));
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

it("rejects a lossy legacy import and retries corrected JSON after a restart", async () => {
  const legacyFile = path.join(dir, "db.json");
  fs.writeFileSync(legacyFile, JSON.stringify({
    settings: { imported: true },
    apiKeys: [{ id: "one", key: "same" }, { id: "two", key: "same" }],
  }));
  const { getAdapter } = await import(`${dbRoot}/driver.js`);
  await expect(getAdapter()).rejects.toThrow(/apiKeys row-count mismatch/);
  expect(global._dbAdapter.instance).toBeNull();
  expect(global._dbAdapter.initPromise).toBeNull();
  expect(fs.existsSync(path.join(dir, "db/.migrated-from-json"))).toBe(false);

  // A rejected boot must not prevent recovery in the same process either.
  fs.writeFileSync(legacyFile, JSON.stringify({ settings: { imported: true }, apiKeys: [{ id: "one", key: "fixed" }] }));
  const db = await getAdapter();
  expect(db.all("SELECT id, key FROM apiKeys")).toEqual([{ id: "one", key: "fixed" }]);
  expect(JSON.parse(db.get("SELECT data FROM settings WHERE id = 1").data)).toEqual({ imported: true });
  db.close();
  delete global._dbAdapter;
  vi.resetModules();
  const restarted = await import(`${dbRoot}/driver.js`);
  const persisted = await restarted.getAdapter();
  expect(persisted.all("SELECT id, key FROM apiKeys")).toEqual([{ id: "one", key: "fixed" }]);
  expect(persisted.get("SELECT value FROM _meta WHERE key = 'legacyImportPending'").value).toBe("0");
});
