import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const openAdapters = [];
const dirs = [];

afterEach(() => {
  for (const db of openAdapters.splice(0)) db.close();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const factories = {
  sqljs: async () => (await import("@/lib/db/adapters/sqljsAdapter.js")).createSqlJsAdapter,
  nodeSqlite: async () => (await import("@/lib/db/adapters/nodeSqliteAdapter.js")).createNodeSqliteAdapter,
  betterSqlite: async () => (await import("@/lib/db/adapters/betterSqliteAdapter.js")).createBetterSqliteAdapter,
};

async function open(driver) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "db-adapter-integrity-"));
  dirs.push(dir);
  const factory = await factories[driver]();
  const db = await factory(path.join(dir, "data.sqlite"));
  openAdapters.push(db);
  return db;
}

// REQUIRE_NATIVE_SQLITE=1 (set by the CI job that builds better-sqlite3) turns
// a missing native binding into a failure instead of a skipped suite.
async function nativeDriverAvailable(driver) {
  const moduleId = driver === "nodeSqlite" ? "node:sqlite" : "better-sqlite3";
  try {
    // Probe native bindings separately so adapter bugs still fail the tests.
    const native = await import(moduleId);
    const Database = driver === "nodeSqlite" ? native.DatabaseSync : native.default;
    const db = new Database(":memory:");
    db.close();
    return true;
  } catch (error) {
    if (process.env.REQUIRE_NATIVE_SQLITE === "1") throw error;
    if (["ERR_UNKNOWN_BUILTIN_MODULE", "ERR_MODULE_NOT_FOUND", "MODULE_NOT_FOUND", "ERR_DLOPEN_FAILED"].includes(error.code) ||
        /Could not locate the bindings file|compiled against a different Node/i.test(error.message)) return false;
    throw error;
  }
}

for (const driver of ["sqljs", "nodeSqlite", "betterSqlite"]) {
  const available = driver === "sqljs" || await nativeDriverAvailable(driver);
  describe.skipIf(!available)(`${driver} adapter integrity`, () => {
    it("enforces foreign keys after the persistence debounce", async () => {
      const db = await open(driver);
      db.exec("CREATE TABLE parents(id INTEGER PRIMARY KEY); CREATE TABLE children(parentId INTEGER REFERENCES parents(id))");
      await new Promise((resolve) => setTimeout(resolve, 160));
      expect(db.get("PRAGMA foreign_keys").foreign_keys).toBe(1);
      expect(() => db.run("INSERT INTO children VALUES(?)", [999])).toThrow(/FOREIGN KEY/i);
    });

    it("removes shutdown handlers when the connection closes", async () => {
      const events = ["beforeExit", "SIGINT", "SIGTERM"];
      const before = events.map((event) => process.listenerCount(event));
      const db = await open(driver);
      db.exec("CREATE TABLE entries(id)");
      db.close();
      openAdapters.pop();
      expect(events.map((event) => process.listenerCount(event))).toEqual(before);
    });
  });
}
