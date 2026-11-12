// Migration 005 adds the key-limit columns to a database from before them,
// leaves every existing key without limits, and seeds each key's running
// spend from the usage history it already has.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let tempDir;
const originalDataDir = process.env.DATA_DIR;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "10router-mig005-"));
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

// The apiKeys table as schema version 4 had it.
const V4_API_KEYS = `CREATE TABLE apiKeys (
  id TEXT PRIMARY KEY, key TEXT UNIQUE NOT NULL, name TEXT, machineId TEXT,
  isActive INTEGER DEFAULT 1, limitHold INTEGER, createdAt TEXT NOT NULL)`;

async function restart() {
  global._dbAdapter?.instance?.close?.();
  delete global._dbAdapter;
  vi.resetModules();
  const { getAdapter } = await import("@/lib/db/driver.js");
  return getAdapter();
}

function addUsage(db, apiKey, cost, timestamp) {
  db.run(
    `INSERT INTO usageHistory(timestamp, provider, model, apiKey, promptTokens, completionTokens, cost, status, tokens, meta)
     VALUES(?, 'p', 'm', ?, 1, 1, ?, 'ok', '{}', '{}')`,
    [timestamp, apiKey, cost]
  );
}

describe("migration 005: api key budgets", () => {
  it("adds the columns, keeps existing keys unlimited and seeds their spend from history", async () => {
    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();
    // Rebuild the pre-005 shape: old apiKeys table, no per-key index.
    db.exec("DROP TABLE apiKeys");
    db.exec(V4_API_KEYS);
    db.exec("DROP INDEX IF EXISTS idx_uh_apikey");
    db.run(`INSERT INTO apiKeys(id, key, name, machineId, isActive, limitHold, createdAt) VALUES('k1', 'sk-old-one', 'Old', 'm', 1, 0, '2026-01-01T00:00:00.000Z')`);
    db.run(`INSERT INTO apiKeys(id, key, name, machineId, isActive, limitHold, createdAt) VALUES('k2', 'sk-old-two', 'Paused', 'm', 0, NULL, '2026-02-01T00:00:00.000Z')`);
    addUsage(db, "sk-old-one", 1.5, "2026-03-01T00:00:00.000Z");
    addUsage(db, "sk-old-one", 2.25, "2026-03-02T00:00:00.000Z");
    addUsage(db, "sk-someone", 99, "2026-03-03T00:00:00.000Z");
    db.run("UPDATE _meta SET value = '4' WHERE key = 'schemaVersion'");

    const upgraded = await restart();
    const columns = upgraded.all("PRAGMA table_info(apiKeys)").map((c) => c.name);
    for (const c of ["budgetUsd", "allowedModels", "expiresAt", "spentUsd", "spendOffsetUsd", "spendResetAt", "requestCount", "lastUsedAt"]) {
      expect(columns).toContain(c);
    }
    expect(upgraded.all("PRAGMA index_list(usageHistory)").map((i) => i.name)).toContain("idx_uh_apikey");
    expect(upgraded.get("SELECT value FROM _meta WHERE key = 'schemaVersion'").value).toBe(String((await import("@/lib/db/migrations/index.js")).latestVersion()));

    const { getApiKeys } = await import("@/lib/db/index.js");
    const keys = await getApiKeys();
    expect(keys).toEqual([
      expect.objectContaining({
        id: "k1", key: "sk-old-one", name: "Old", isActive: true, limitHold: false, createdAt: "2026-01-01T00:00:00.000Z",
        budgetUsd: null, allowedModels: null, expiresAt: null, spendOffsetUsd: 0, spendResetAt: null,
        spentUsd: 3.75, lifetimeSpentUsd: 3.75, requestCount: 2, lastUsedAt: "2026-03-02T00:00:00.000Z",
      }),
      expect.objectContaining({
        id: "k2", key: "sk-old-two", name: "Paused", isActive: false, limitHold: null,
        budgetUsd: null, allowedModels: null, expiresAt: null, spentUsd: 0, requestCount: 0, lastUsedAt: null,
      }),
    ]);

    // An upgraded key with no limits is let through.
    const { checkApiKeyLimits } = await import("@/sse/services/keyLimits.js");
    expect(await checkApiKeyLimits("sk-old-one", { model: "any/model" })).toBeNull();
  });

  it("is a no-op on a fresh database, which already has the columns", async () => {
    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();
    expect(db.get("SELECT value FROM _meta WHERE key = 'schemaVersion'").value).toBe(String((await import("@/lib/db/migrations/index.js")).latestVersion()));
    expect(db.all("PRAGMA table_info(apiKeys)").map((c) => c.name)).toContain("spentUsd");
  });

  it("restoring a backup rebuilds the running spend from history and keeps limits", async () => {
    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();
    addUsage(db, "sk-restored", 4, "2026-04-01T00:00:00.000Z");
    const { importDb, exportDb, getApiKeys } = await import("@/lib/db/index.js");
    await importDb({
      apiKeys: [
        { id: "r1", key: "sk-restored", name: "Restored", machineId: "m", isActive: true, createdAt: "2026-01-01T00:00:00.000Z", budgetUsd: 10, allowedModels: ["a/b"], spendOffsetUsd: 1 },
        // A backup from before key limits: no limit fields at all.
        { id: "r2", key: "sk-legacy", name: "Legacy", machineId: "m", isActive: true, createdAt: "2026-01-01T00:00:00.000Z" },
      ],
    });
    const [restored, legacy] = await getApiKeys();
    expect(restored).toMatchObject({ budgetUsd: 10, allowedModels: ["a/b"], lifetimeSpentUsd: 4, spentUsd: 3, requestCount: 1 });
    expect(legacy).toMatchObject({ budgetUsd: null, allowedModels: null, expiresAt: null, spentUsd: 0 });
    const exported = await exportDb();
    expect(exported.apiKeys.find((k) => k.id === "r1")).toMatchObject({ budgetUsd: 10, allowedModels: ["a/b"], spendOffsetUsd: 1 });
  });

  it("a backup restored onto an empty install keeps each key's spend, so budgets aren't refilled", async () => {
    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();
    db.run(`INSERT INTO apiKeys(id, key, name, machineId, isActive, createdAt, budgetUsd) VALUES('b1', 'sk-moved', 'Moved', 'm', 1, '2026-01-01T00:00:00.000Z', 5)`);
    addUsage(db, "sk-moved", 4.5, "2026-04-01T00:00:00.000Z");
    addUsage(db, "sk-moved", 1, "2026-04-02T00:00:00.000Z");
    const { exportDb } = await import("@/lib/db/index.js");
    const { reseedApiKeySpend } = await import("@/lib/db/repos/apiKeysRepo.js");
    reseedApiKeySpend(db);
    const backup = JSON.parse(JSON.stringify(await exportDb()));

    // Another install: a new data dir with no history at all.
    global._dbAdapter?.instance?.close?.();
    fs.rmSync(tempDir, { recursive: true, force: true });
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "10router-mig005-"));
    process.env.DATA_DIR = tempDir;
    const fresh = await restart();
    expect(fresh.get("SELECT COUNT(*) AS c FROM usageHistory").c).toBe(0);
    const { importDb, getApiKeys } = await import("@/lib/db/index.js");
    await importDb(backup);
    const [moved] = await getApiKeys();
    expect(moved).toMatchObject({ id: "b1", budgetUsd: 5, requestCount: 2, lastUsedAt: "2026-04-02T00:00:00.000Z" });
    expect(moved.spentUsd).toBeCloseTo(5.5, 9);
    const { checkApiKeyLimits } = await import("@/sse/services/keyLimits.js");
    expect((await checkApiKeyLimits("sk-moved", { model: "any/model" }))?.status).toBe(402);
  });

  it("seeds spend for keys and history imported from a legacy JSON install", async () => {
    fs.writeFileSync(path.join(tempDir, "db.json"), JSON.stringify({
      apiKeys: [{ id: "l1", key: "sk-legacy-json", name: "Legacy", machineId: "m", isActive: true, createdAt: "2025-01-01T00:00:00.000Z" }],
    }));
    fs.writeFileSync(path.join(tempDir, "usage.json"), JSON.stringify({
      history: [
        { timestamp: "2025-02-01T00:00:00.000Z", provider: "p", model: "m", apiKey: "sk-legacy-json", cost: 0.75, tokens: { prompt_tokens: 1 } },
        { timestamp: "2025-02-03T00:00:00.000Z", provider: "p", model: "m", apiKey: "sk-legacy-json", cost: 1.25, tokens: { prompt_tokens: 1 } },
      ],
    }));
    await restart();
    const { getApiKeys } = await import("@/lib/db/index.js");
    const [legacy] = await getApiKeys();
    expect(legacy).toMatchObject({ id: "l1", requestCount: 2, lastUsedAt: "2025-02-03T00:00:00.000Z", budgetUsd: null });
    expect(legacy.spentUsd).toBeCloseTo(2, 9);
  });
});
