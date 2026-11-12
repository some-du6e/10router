// Migration 006 brings a schema-5 database up to management keys: the two new
// tables, and an owner column on apiKeys and providerConnections that reads as
// "created in the dashboard" (NULL) for every existing row.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let tempDir;
const originalDataDir = process.env.DATA_DIR;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "10router-mig006-"));
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

async function restart() {
  global._dbAdapter?.instance?.close?.();
  delete global._dbAdapter;
  vi.resetModules();
  const { getAdapter } = await import("@/lib/db/driver.js");
  return getAdapter();
}

/** Rebuild a table as it was before 006: every current column but the owner one. */
function dropOwnerColumn(db, table) {
  const cols = db.all(`PRAGMA table_info(${table})`).map((c) => c.name).filter((c) => !["ownerManagementKeyId", "disabledBy", "expiresAtSetBy"].includes(c));
  db.exec(`CREATE TABLE ${table}_old AS SELECT ${cols.join(", ")} FROM ${table}`);
  db.exec(`DROP TABLE ${table}`);
  db.exec(`ALTER TABLE ${table}_old RENAME TO ${table}`);
}

describe("migration 006: management keys", () => {
  it("adds the tables and owner columns, and leaves existing rows owned by no management key", async () => {
    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();
    db.run(`INSERT INTO apiKeys(id, key, name, machineId, isActive, createdAt) VALUES('k1', 'sk-old', 'Old', 'm', 1, '2026-01-01T00:00:00.000Z')`);
    db.run(`INSERT INTO providerConnections(id, provider, authType, name, isActive, data, createdAt, updatedAt) VALUES('c1', 'openai', 'apikey', 'Old', 1, '{"apiKey":"x"}', '2026-01-01', '2026-01-01')`);
    db.exec("DROP TABLE managementKeys");
    db.exec("DROP TABLE managementAudit");
    dropOwnerColumn(db, "apiKeys");
    dropOwnerColumn(db, "providerConnections");
    db.run("UPDATE _meta SET value = '5' WHERE key = 'schemaVersion'");

    const upgraded = await restart();
    expect(upgraded.get("SELECT value FROM _meta WHERE key = 'schemaVersion'").value).toBe("6");
    for (const table of ["apiKeys", "providerConnections"]) {
      expect(upgraded.all(`PRAGMA table_info(${table})`).map((c) => c.name)).toContain("ownerManagementKeyId");
    }
    for (const col of ["disabledBy", "expiresAtSetBy"]) {
      expect(upgraded.all("PRAGMA table_info(apiKeys)").map((c) => c.name)).toContain(col);
    }
    expect(upgraded.all("PRAGMA index_list(apiKeys)").map((i) => i.name)).toContain("idx_ak_owner");
    expect(upgraded.all("PRAGMA index_list(providerConnections)").map((i) => i.name)).toContain("idx_pc_owner");
    const tables = upgraded.all("SELECT name FROM sqlite_master WHERE type = 'table'").map((t) => t.name);
    expect(tables).toEqual(expect.arrayContaining(["managementKeys", "managementAudit"]));

    expect(upgraded.get("SELECT ownerManagementKeyId FROM apiKeys WHERE id = 'k1'").ownerManagementKeyId).toBeNull();
    expect(upgraded.get("SELECT ownerManagementKeyId FROM providerConnections WHERE id = 'c1'").ownerManagementKeyId).toBeNull();
    const { getApiKeyById, getProviderConnectionById } = await import("@/lib/db/index.js");
    expect(await getApiKeyById("k1")).toMatchObject({ key: "sk-old", name: "Old" });
    // The owner column stays out of the connection's data JSON.
    const conn = await getProviderConnectionById("c1");
    expect(conn).toMatchObject({ apiKey: "x", name: "Old" });
    expect(conn).not.toHaveProperty("ownerManagementKeyId");
  });

  it("upgrades a legacy unstamped database (version 0) whose tables lack the owner columns", async () => {
    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();
    dropOwnerColumn(db, "apiKeys");
    dropOwnerColumn(db, "providerConnections");
    db.run("UPDATE _meta SET value = '0' WHERE key = 'schemaVersion'");
    // 001 can't build the owner indexes yet; it must not fail on them.
    const upgraded = await restart();
    expect(upgraded.all("PRAGMA index_list(apiKeys)").map((i) => i.name)).toContain("idx_ak_owner");
    expect(upgraded.all("PRAGMA table_info(providerConnections)").map((c) => c.name)).toContain("ownerManagementKeyId");
  });

  it("keeps a connection's owner through the dashboard's updates", async () => {
    const { getAdapter } = await import("@/lib/db/driver.js");
    await getAdapter();
    const db = await import("@/lib/db/index.js");
    const conn = await db.createProviderConnection({ provider: "openai", authType: "apikey", name: "owned", apiKey: "k" });
    const key = await db.createApiKey("owned", "machine");
    await db.setRowOwner("providerKey", conn.id, "mk-1");
    await db.setRowOwner("clientKey", key.id, "mk-1");
    await db.updateProviderConnection(conn.id, { name: "renamed", testStatus: "active" });
    await db.updateApiKey(key.id, { name: "renamed", budgetUsd: 3 });
    expect(await db.getRowOwner("providerKey", conn.id)).toBe("mk-1");
    expect(await db.getRowOwner("clientKey", key.id)).toBe("mk-1");
  });
});

describe("migration 001 on a legacy table", () => {
  async function run001(execError) {
    const { default: m001 } = await import("@/lib/db/migrations/001-initial.js");
    const fake = {
      exec(sql) {
        if (sql.startsWith("CREATE INDEX") && sql.includes("ownerManagementKeyId")) throw new Error(execError);
      },
    };
    return () => m001.up(fake);
  }

  it("skips an index whose column a later migration adds", async () => {
    expect(await run001("no such column: ownerManagementKeyId")).not.toThrow();
  });

  it("rethrows any other error", async () => {
    expect(await run001("database disk image is malformed")).toThrow(/malformed/);
  });
});
