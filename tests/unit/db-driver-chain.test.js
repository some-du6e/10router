// Verify 3-tier driver fallback: better-sqlite3 → node:sqlite → sql.js
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let tempDir;
const originalDataDir = process.env.DATA_DIR;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "10router-chain-"));
  process.env.DATA_DIR = tempDir;
  delete global._dbAdapter;
  vi.resetModules();
});

afterEach(() => {
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("Driver fallback chain", () => {
  it("default → picks better-sqlite3 when available", async () => {
    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();
    expect(["better-sqlite3", "node:sqlite", "sql.js"]).toContain(db.driver);
  });

  it("falls back to node:sqlite when better-sqlite3 unavailable", async () => {
    // Mock the better-sqlite3 adapter to throw
    vi.doMock("@/lib/db/adapters/betterSqliteAdapter.js", () => {
      throw new Error("simulated unavailable");
    });
    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();
    // Node 22.5+ should give node:sqlite, else sql.js
    const [maj, min] = process.versions.node.split(".").map(Number);
    if (maj > 22 || (maj === 22 && min >= 5)) {
      expect(db.driver).toBe("node:sqlite");
    } else {
      expect(db.driver).toBe("sql.js");
    }
  });

  it("falls back to sql.js when both native drivers unavailable", async () => {
    vi.doMock("@/lib/db/adapters/betterSqliteAdapter.js", () => {
      throw new Error("simulated unavailable");
    });
    vi.doMock("@/lib/db/adapters/nodeSqliteAdapter.js", () => {
      throw new Error("simulated unavailable");
    });
    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();
    expect(db.driver).toBe("sql.js");
  });

  describe("with the gateway in native mode", () => {
    const originalMode = process.env.GATEWAY_MODE;
    beforeEach(() => {
      process.env.GATEWAY_MODE = "native";
      // A doMock outlives vi.resetModules: start each case with the real adapters.
      for (const adapter of ["betterSqliteAdapter", "nodeSqliteAdapter", "sqljsAdapter"]) vi.doUnmock(`@/lib/db/adapters/${adapter}.js`);
    });
    afterEach(() => {
      if (originalMode === undefined) delete process.env.GATEWAY_MODE;
      else process.env.GATEWAY_MODE = originalMode;
    });

    it("refuses sql.js rather than overwrite the gateway's writes", async () => {
      vi.doMock("@/lib/db/adapters/betterSqliteAdapter.js", () => {
        throw new Error("simulated unavailable");
      });
      vi.doMock("@/lib/db/adapters/nodeSqliteAdapter.js", () => {
        throw new Error("simulated unavailable");
      });
      const sqljs = vi.fn();
      vi.doMock("@/lib/db/adapters/sqljsAdapter.js", () => ({ createSqlJsAdapter: sqljs }));
      const { getAdapter, SQLJS_REFUSED_MESSAGE } = await import("@/lib/db/driver.js");
      await expect(getAdapter()).rejects.toThrow(SQLJS_REFUSED_MESSAGE);
      expect(sqljs).not.toHaveBeenCalled();
      // Nothing was written: no database file was created either.
      expect(fs.existsSync(path.join(tempDir, "db", "data.sqlite"))).toBe(false);
    });

    it("still opens a native driver", async () => {
      vi.doMock("@/lib/db/adapters/betterSqliteAdapter.js", () => {
        throw new Error("simulated unavailable");
      });
      const [maj, min] = process.versions.node.split(".").map(Number);
      const { getAdapter } = await import("@/lib/db/driver.js");
      if (maj > 22 || (maj === 22 && min >= 5)) expect((await getAdapter()).driver).toBe("node:sqlite");
      else await expect(getAdapter()).rejects.toThrow(/GATEWAY_MODE=native/);
    });

    it("only native mode refuses: proxy mode never opens the database from Go", async () => {
      process.env.GATEWAY_MODE = "proxy";
      vi.doMock("@/lib/db/adapters/betterSqliteAdapter.js", () => {
        throw new Error("simulated unavailable");
      });
      vi.doMock("@/lib/db/adapters/nodeSqliteAdapter.js", () => {
        throw new Error("simulated unavailable");
      });
      const { getAdapter } = await import("@/lib/db/driver.js");
      expect((await getAdapter()).driver).toBe("sql.js");
    });
  });
});
