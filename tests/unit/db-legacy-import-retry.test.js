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
  vi.doUnmock("@/lib/db/adapters/betterSqliteAdapter.js");
  vi.doUnmock("@/lib/db/adapters/nodeSqliteAdapter.js");
  global._dbAdapter?.instance?.close();
  delete global._dbAdapter;
  fs.rmSync(dir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

const writeLegacy = (data) => fs.writeFileSync(legacyFile, JSON.stringify(data));
const importBackups = () => fs.readdirSync(path.join(dir, "db/backups")).filter((name) => name.startsWith("migrate-from-json-"));
const pendingFlag = (db) => db.get("SELECT value FROM _meta WHERE key = 'legacyImportPending'")?.value;

// The detailed line goes to the server log; callers (and the routes that echo
// a DB error to clients) get only the generic message.
const abortMessage = /legacy import from .*aborted: .*SKIP_LEGACY_IMPORT=1/;
const importFailed = /^\[DB\] legacy import failed; see the server log$/;
const abortLines = (consoleError) => consoleError.mock.calls.map((c) => String(c[0])).filter((line) => abortMessage.test(line));
const failure = (promise) => promise.then(() => { throw new Error("expected the init to fail"); }, (error) => error);
const migratedMarker = () => fs.existsSync(path.join(dir, "db/.migrated-from-json"));

// Reads the import flag the way an operator would get past a broken file: boot
// with SKIP_LEGACY_IMPORT=1, which leaves the flag as it is.
async function flagAfterSkippedBoot() {
  vi.stubEnv("SKIP_LEGACY_IMPORT", "1");
  const db = await (await restart()).getAdapter();
  return pendingFlag(db);
}

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
  const error = await failure(getAdapter());
  expect(error.message).toMatch(importFailed);
  expect(error.cause.message).toMatch(/apiKeys row-count mismatch/);
  expect(global._dbAdapter.instance).toBeNull();
  expect(global._dbAdapter.initPromise).toBeNull();
  expect(fs.existsSync(path.join(dir, "db/.migrated-from-json"))).toBe(false);
  const [abort] = abortLines(consoleError);
  expect(abort).toContain(legacyFile);
  expect(abort).toContain("apiKeys row-count mismatch");

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
  expect(errors[0].cause.message).toMatch(/row-count mismatch/);
  for (const error of errors) expect(error).toBe(errors[0]);
  expect(imports()).toBe(1);
  expect(importBackups()).toHaveLength(1);

  vi.setSystemTime(Date.now() + INIT_RETRY_BACKOFF_MS + 1000);
  await expect(getAdapter()).rejects.toThrow(importFailed);
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

it.each([
  ["alone", {}],
  ["next to a valid usage.json", { "usage.json": { history: [{ timestamp: "2025-02-01T00:00:00.000Z", provider: "p", model: "m", tokens: {} }] } }],
])("aborts on a db.json that won't parse (%s) and keeps the import pending", async (_name, others) => {
  fs.writeFileSync(legacyFile, '{ "settings": { "imported": true }, }');
  for (const [name, data] of Object.entries(others)) fs.writeFileSync(path.join(dir, name), JSON.stringify(data));
  const consoleError = vi.spyOn(console, "error");
  const { getAdapter } = await import("@/lib/db/driver.js");
  await expect(getAdapter()).rejects.toThrow(importFailed);
  const [abort] = abortLines(consoleError);
  expect(abort).toContain(legacyFile);
  expect(abort).toMatch(/db\.json is not valid JSON/);
  expect(migratedMarker()).toBe(false);
  expect(await flagAfterSkippedBoot()).toBe("1");
  const db = global._dbAdapter.instance;
  expect(db.get("SELECT COUNT(*) AS c FROM usageHistory").c).toBe(0);
  expect(migratedMarker()).toBe(false);
});

it("keeps paths and file content out of the error callers get", async () => {
  // The parse error quotes the text around the mistake, here part of a key.
  fs.writeFileSync(legacyFile, '{"apiKeys":[{"key":"sk-placeholder-secret-0001", oops}]}');
  const consoleError = vi.spyOn(console, "error");
  const { getAdapter } = await import("@/lib/db/driver.js");
  const error = await failure(getAdapter());

  expect(error.message).toMatch(importFailed);
  expect(error.message).not.toContain(dir);
  expect(error.message).not.toContain("db.json");
  expect(error.message).not.toMatch(/placeholder|secret-0001|oops/);
  expect(abortLines(consoleError)[0]).toContain(legacyFile);
});

it("aborts when the pre-import backup fails, and takes the backup on the next try", async () => {
  writeLegacy(fixed);
  vi.spyOn(fs, "copyFileSync").mockImplementationOnce(() => { throw new Error("simulated disk full"); });
  const consoleError = vi.spyOn(console, "error");
  const { getAdapter, retryAdapterInit } = await import("@/lib/db/driver.js");
  await expect(getAdapter()).rejects.toThrow(importFailed);
  expect(abortLines(consoleError)[0]).toMatch(/aborted: simulated disk full/);
  expect(importBackups()).toEqual([]);
  expect(migratedMarker()).toBe(false);

  const db = await retryAdapterInit();
  expect(importBackups()).toHaveLength(1);
  expect(db.all("SELECT id, key FROM apiKeys")).toEqual([{ id: "one", key: "fixed" }]);
});

it("keeps the import error and drops the listeners when closing the failed adapter throws", async () => {
  // sql.js is the adapter whose close() writes the file, so a full disk throws there.
  vi.doMock("@/lib/db/adapters/betterSqliteAdapter.js", () => { throw new Error("simulated unavailable"); });
  vi.doMock("@/lib/db/adapters/nodeSqliteAdapter.js", () => { throw new Error("simulated unavailable"); });
  writeLegacy(lossy);
  const consoleWarn = vi.spyOn(console, "warn");
  const events = ["beforeExit", "SIGINT", "SIGTERM"];
  const before = events.map((event) => process.listenerCount(event));
  vi.spyOn(fs, "writeFileSync").mockImplementation(() => { throw new Error("simulated ENOSPC"); });

  const { getAdapter } = await import("@/lib/db/driver.js");
  const error = await failure(getAdapter());
  expect(error.message).toMatch(importFailed);
  expect(error.cause.message).toMatch(/apiKeys row-count mismatch/);
  expect(consoleWarn.mock.calls.some((c) => /closing the adapter after a failed init failed: simulated ENOSPC/.test(String(c[0])))).toBe(true);
  expect(events.map((event) => process.listenerCount(event))).toEqual(before);
});

it("never prunes a backup this process made, however many newer ones exist", async () => {
  writeLegacy(lossy);
  const { getAdapter } = await import("@/lib/db/driver.js");
  await expect(getAdapter()).rejects.toThrow();
  const [ours] = importBackups();
  const backups = path.join(dir, "db/backups");
  const seed = (name, offsetMs) => {
    const target = path.join(backups, name);
    fs.mkdirSync(target);
    const at = new Date(Date.now() + offsetMs);
    fs.utimesSync(target, at, at);
  };
  seed("newer-1", 60_000);
  seed("newer-2", 120_000);
  seed("newer-3", 180_000);
  seed("older", -3_600_000);

  const { pruneOldBackups } = await import("@/lib/db/backup.js");
  pruneOldBackups();
  expect(fs.readdirSync(backups).sort()).toEqual([ours, "newer-1", "newer-2", "newer-3"].sort());
});
