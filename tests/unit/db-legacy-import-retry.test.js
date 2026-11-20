import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let dir;
let legacyFile;

// Two keys with the same `key` collapse into one row: a lossy import.
const lossy = { settings: { imported: true }, apiKeys: [{ id: "one", key: "same" }, { id: "two", key: "same" }] };
const fixed = { settings: { imported: true, password: "legacy-hash" }, apiKeys: [{ id: "one", key: "fixed" }] };

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "db-import-retry-"));
  legacyFile = path.join(dir, "db.json");
  process.env.DATA_DIR = dir;
  delete global._dbAdapter;
  vi.resetModules();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  global._dbAdapter?.instance?.close();
  delete global._dbAdapter;
  fs.rmSync(dir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

const writeLegacy = (data) => fs.writeFileSync(legacyFile, JSON.stringify(data));
const importBackups = () => fs.readdirSync(path.join(dir, "db/backups")).filter((name) => name.startsWith("migrate-from-json-"));
const pendingFlag = (db) => db.get("SELECT value FROM _meta WHERE key = 'legacyImportPending'")?.value;

// A new process: close the open connection and load the driver from scratch.
async function restart() {
  global._dbAdapter?.instance?.close();
  delete global._dbAdapter;
  vi.resetModules();
  return import("@/lib/db/driver.js");
}

it("rejects a lossy legacy import and imports corrected JSON on an explicit retry and after a restart", async () => {
  const consoleError = vi.spyOn(console, "error");
  writeLegacy(lossy);
  const { getAdapter, retryAdapterInit } = await import("@/lib/db/driver.js");
  await expect(getAdapter()).rejects.toThrow(/apiKeys row-count mismatch/);
  expect(global._dbAdapter.instance).toBeNull();
  expect(global._dbAdapter.initPromise).toBeNull();
  expect(fs.existsSync(path.join(dir, "db/.migrated-from-json"))).toBe(false);
  const abort = consoleError.mock.calls.map((c) => String(c[0])).find((line) => line.includes("aborted"));
  expect(abort).toContain(legacyFile);
  expect(abort).toContain("SKIP_LEGACY_IMPORT=1");

  writeLegacy(fixed);
  const db = await retryAdapterInit();
  expect(db.all("SELECT id, key FROM apiKeys")).toEqual([{ id: "one", key: "fixed" }]);
  expect(JSON.parse(db.get("SELECT data FROM settings WHERE id = 1").data)).toMatchObject({ imported: true });

  const persisted = await (await restart()).getAdapter();
  expect(persisted.all("SELECT id, key FROM apiKeys")).toEqual([{ id: "one", key: "fixed" }]);
  expect(pendingFlag(persisted)).toBe("0");
});

it("runs a failing init and its backup once per backoff, and keeps the backup across later retries", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const consoleWarn = vi.spyOn(console, "warn");
  const imports = () => consoleWarn.mock.calls.filter((c) => /row-count mismatch/.test(String(c[0]))).length;
  writeLegacy(lossy);
  const { getAdapter, INIT_RETRY_BACKOFF_MS } = await import("@/lib/db/driver.js");

  const errors = [];
  for (let i = 0; i < 5; i++) errors.push(await getAdapter().catch((error) => error));
  expect(errors[0].message).toMatch(/row-count mismatch/);
  for (const error of errors) expect(error).toBe(errors[0]);
  expect(imports()).toBe(1);
  expect(importBackups()).toHaveLength(1);

  vi.setSystemTime(Date.now() + INIT_RETRY_BACKOFF_MS + 1000);
  await expect(getAdapter()).rejects.toThrow(/row-count mismatch/);
  expect(imports()).toBe(2);
  expect(importBackups()).toHaveLength(1);
});

it("closes the adapter of a failed init and removes its shutdown listeners", async () => {
  const events = ["beforeExit", "SIGINT", "SIGTERM"];
  const before = events.map((event) => process.listenerCount(event));
  writeLegacy(lossy);
  const { getAdapter } = await import("@/lib/db/driver.js");
  await expect(getAdapter()).rejects.toThrow();
  expect(events.map((event) => process.listenerCount(event))).toEqual(before);
});

it("never imports legacy JSON restored after the files were removed and the install was set up", async () => {
  writeLegacy(lossy);
  const { getAdapter, retryAdapterInit } = await import("@/lib/db/driver.js");
  await expect(getAdapter()).rejects.toThrow();

  fs.rmSync(legacyFile);
  const db = await retryAdapterInit();
  expect(pendingFlag(db)).toBe("0");
  db.run("INSERT INTO settings(id, data) VALUES(1, ?)", [JSON.stringify({ password: "live-hash" })]);

  writeLegacy(fixed);
  const restarted = await (await restart()).getAdapter();
  expect(JSON.parse(restarted.get("SELECT data FROM settings WHERE id = 1").data)).toEqual({ password: "live-hash" });
  expect(restarted.all("SELECT id FROM apiKeys")).toEqual([]);
});

it("SKIP_LEGACY_IMPORT=1 boots without importing, and a later boot never imports over the data set up since", async () => {
  writeLegacy(lossy);
  vi.stubEnv("SKIP_LEGACY_IMPORT", "1");
  const { getAdapter } = await import("@/lib/db/driver.js");
  const db = await getAdapter();
  expect(db.all("SELECT id FROM apiKeys")).toEqual([]);
  db.run("INSERT INTO settings(id, data) VALUES(1, ?)", [JSON.stringify({ password: "live-hash" })]);

  vi.unstubAllEnvs();
  writeLegacy(fixed);
  const restarted = await (await restart()).getAdapter();
  expect(JSON.parse(restarted.get("SELECT data FROM settings WHERE id = 1").data)).toEqual({ password: "live-hash" });
  expect(restarted.all("SELECT id FROM apiKeys")).toEqual([]);
  expect(pendingFlag(restarted)).toBe("0");
});

it("does not import legacy JSON into an install that was already running without it", async () => {
  const { getAdapter } = await import("@/lib/db/driver.js");
  await getAdapter();

  writeLegacy(fixed);
  const restarted = await (await restart()).getAdapter();
  expect(restarted.all("SELECT id FROM apiKeys")).toEqual([]);
  expect(restarted.get("SELECT data FROM settings WHERE id = 1")).toBeUndefined();
  expect(fs.existsSync(path.join(dir, "db/.migrated-from-json"))).toBe(false);
});
