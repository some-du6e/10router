// The database file is shared with a second process (the Go gateway,
// docs/GO_GATEWAY.md). A transaction that reads before it writes must wait for
// the other process's write lock, as a single write does: SQLite skips the
// busy handler when a deferred transaction upgrades from reading to writing,
// so the adapters begin IMMEDIATE.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FACTORIES, driverAvailable, tempDataDir } from "../helpers/nodeDb.js";

const open = [];
const dirs = [];
afterEach(() => {
  for (const db of open.splice(0)) db.close();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

// Another process holding the write lock for holdMs; resolves once it has it.
function holdWriteLock(file, holdMs) {
  const script = `
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(process.argv[1]);
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec("BEGIN IMMEDIATE");
    db.exec("INSERT INTO t(v) VALUES('other')");
    process.stdout.write("locked\\n");
    setTimeout(() => { db.exec("COMMIT"); db.close(); }, Number(process.argv[2]));
  `;
  const child = spawn(process.execPath, ["--no-warnings", "-e", script, file, String(holdMs)], { stdio: ["ignore", "pipe", "inherit"] });
  const exited = new Promise((resolve) => child.on("exit", resolve));
  const locked = new Promise((resolve, reject) => {
    child.stdout.on("data", (d) => { if (String(d).includes("locked")) resolve(); });
    child.on("exit", (code) => reject(new Error(`lock holder exited ${code}`)));
  });
  return { locked, exited };
}

const lockHolderAvailable = await driverAvailable("node:sqlite");

for (const driver of ["node:sqlite", "better-sqlite3"]) {
  const available = lockHolderAvailable && await driverAvailable(driver);
  describe.skipIf(!available)(`${driver} sharing the file`, () => {
    it("a transaction that reads, then writes, waits for another process's lock", async () => {
      const dir = tempDataDir("db-shared-file-");
      dirs.push(dir);
      const file = path.join(dir, "data.sqlite");
      const db = await (await FACTORIES[driver]())(file);
      open.push(db);
      db.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT)");

      const holder = holdWriteLock(file, 300);
      await holder.locked;
      const started = Date.now();
      // Read first, as updateSettings, updateProviderConnection and every
      // read-merge-write repo do.
      db.transaction(() => {
        const n = db.get("SELECT COUNT(*) AS n FROM t").n;
        db.run("INSERT INTO t(v) VALUES(?)", [`after ${n}`]);
      });
      expect(Date.now() - started).toBeGreaterThanOrEqual(200);
      await holder.exited;
      expect(db.all("SELECT v FROM t ORDER BY id").map((r) => r.v)).toEqual(["other", "after 1"]);
    });

    it("nested transactions still commit and roll back together", async () => {
      const dir = tempDataDir("db-shared-file-");
      dirs.push(dir);
      const db = await (await FACTORIES[driver]())(path.join(dir, "data.sqlite"));
      open.push(db);
      db.exec("CREATE TABLE t(v TEXT)");
      db.transaction(() => {
        db.run("INSERT INTO t VALUES('outer')");
        db.transaction(() => db.run("INSERT INTO t VALUES('inner')"));
      });
      expect(() => db.transaction(() => {
        db.run("INSERT INTO t VALUES('lost')");
        db.transaction(() => { throw new Error("boom"); });
      })).toThrow("boom");
      expect(() => db.transaction(() => {
        db.transaction(() => db.run("INSERT INTO t VALUES('kept?')"));
        throw new Error("outer boom");
      })).toThrow("outer boom");
      expect(db.all("SELECT v FROM t").map((r) => r.v)).toEqual(["outer", "inner"]);
      // The adapter is usable after a rollback.
      db.transaction(() => db.run("INSERT INTO t VALUES('again')"));
      expect(db.get("SELECT COUNT(*) AS n FROM t").n).toBe(3);
    });
  });
}
