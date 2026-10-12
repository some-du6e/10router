import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const dbRoot = process.env.DB_AUDIT_ROOT || path.resolve(import.meta.dirname, "../../src/lib/db");
const openAdapters = [];
const dirs = [];

afterEach(() => {
  for (const db of openAdapters.splice(0)) db.close();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

async function open(driver) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "db-adapter-integrity-"));
  dirs.push(dir);
  const adapterModule = await import(`${dbRoot}/adapters/${driver}Adapter.js`);
  const factory = { sqljs: adapterModule.createSqlJsAdapter, nodeSqlite: adapterModule.createNodeSqliteAdapter, betterSqlite: adapterModule.createBetterSqliteAdapter }[driver];
  const db = await factory(path.join(dir, "data.sqlite"));
  openAdapters.push(db);
  return db;
}

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
    if (["ERR_UNKNOWN_BUILTIN_MODULE", "ERR_MODULE_NOT_FOUND", "MODULE_NOT_FOUND", "ERR_DLOPEN_FAILED"].includes(error.code) ||
        /Could not locate the bindings file|compiled against a different Node/i.test(error.message)) return false;
    throw error;
  }
}

for (const driver of ["sqljs", "nodeSqlite", "betterSqlite"]) {
  const available = driver === "sqljs" || await nativeDriverAvailable(driver);
  describe.skipIf(!available)(`${driver} adapter integrity`, () => {
    it("rolls back a failed nested transaction while committing the outer transaction", async () => {
      const db = await open(driver);
      db.exec("CREATE TABLE entries(id INTEGER PRIMARY KEY, value TEXT)");
      expect(db.transaction(() => {
        db.run("INSERT INTO entries VALUES(?, ?)", [1, "outer"]);
        expect(() => db.transaction(() => {
          db.run("INSERT INTO entries VALUES(?, ?)", [2, "inner"]);
          throw new Error("abort inner");
        })).toThrow("abort inner");
        return "committed";
      })).toBe("committed");
      expect(db.all("SELECT * FROM entries")).toEqual([{ id: 1, value: "outer" }]);
      expect(() => db.transaction(() => {
        db.run("DELETE FROM entries");
        throw new Error("abort outer");
      })).toThrow("abort outer");
      expect(db.get("SELECT value FROM entries WHERE id = ?", [1]).value).toBe("outer");
    });

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
