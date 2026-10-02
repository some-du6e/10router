// Verify schema migration chain runs correctly across versions.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let tempDir;
const originalDataDir = process.env.DATA_DIR;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "10router-mig-"));
  process.env.DATA_DIR = tempDir;
  // Reset global singleton so each test gets fresh adapter pointed at tempDir
  delete global._dbAdapter;
  vi.resetModules();
});

afterEach(() => {
  // Close adapter to release file handles before rm
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("Schema migrations", () => {
  it("moves a working legacy elevation credential to private cleanup and Tailscale storage", async () => {
    const { getAdapter } = await import("@/lib/db/driver.js");
    const { decryptHostPassword } = await import("@/lib/db/helpers/hostCredentials.js");
    const crypto = await import("node:crypto");
    const { machineIdSync } = await import("node-machine-id");
    const key = crypto.createHash("sha256").update(machineIdSync() + "10router-mitm-pwd").digest();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    const ciphertext = Buffer.concat([cipher.update("test-sudo-password", "utf8"), cipher.final()]);
    const legacy = `${iv.toString("hex")}:${cipher.getAuthTag().toString("hex")}:${ciphertext.toString("hex")}`;
    const db = await getAdapter();
    db.run("INSERT INTO settings(id, data) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data", [JSON.stringify({ tailscaleEnabled: true, mitmSudoEncrypted: legacy })]);
    db.run("UPDATE _meta SET value = '2' WHERE key = 'schemaVersion'");
    db.close?.();
    delete global._dbAdapter;
    vi.resetModules();
    const { getAdapter: restart } = await import("@/lib/db/driver.js");
    const upgraded = await restart();
    const rows = upgraded.all("SELECT key, value FROM kv WHERE scope = 'hostCredentials'");
    expect(rows.map((row) => row.key).sort()).toEqual(["retiredProxy", "tailscale"]);
    for (const row of rows) expect(decryptHostPassword(JSON.parse(row.value))).toBe("test-sudo-password");
    const { exportDb } = await import("@/lib/db/index.js");
    const backup = await exportDb();
    expect(JSON.stringify(backup)).not.toContain("test-sudo-password");
    expect(JSON.stringify(backup)).not.toContain(legacy);
    expect(backup.settings).toEqual({ tailscaleEnabled: true });
  });

  it("removes retired proxy settings and aliases on upgrade while preserving provider data", async () => {
    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();
    db.run("INSERT INTO settings(id, data) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data", [
      JSON.stringify({ tunnelEnabled: true, mitmEnabled: true, mitmSudoEncrypted: "obsolete-secret", dnsToolEnabled: { kiro: true } }),
    ]);
    db.run("INSERT INTO kv(scope, key, value) VALUES('mitmAlias', 'kiro', '{}')");
    db.run("INSERT INTO kv(scope, key, value) VALUES('modelAliases', 'default', '\"cx/gpt-6\"')");
    db.run("UPDATE _meta SET value = '2' WHERE key = 'schemaVersion'");
    db.close?.();

    delete global._dbAdapter;
    vi.resetModules();
    const { getAdapter: restart } = await import("@/lib/db/driver.js");
    const upgraded = await restart();
    expect(JSON.parse(upgraded.get("SELECT data FROM settings WHERE id = 1").data)).toEqual({ tunnelEnabled: true });
    expect(upgraded.all("SELECT * FROM kv WHERE scope = 'mitmAlias'")).toEqual([]);
    expect(upgraded.get("SELECT value FROM kv WHERE scope = 'modelAliases' AND key = 'default'").value).toBe('"cx/gpt-6"');
  });

  it("ignores retired proxy credentials and aliases in backup imports", async () => {
    const { importDb, exportDb } = await import("@/lib/db/index.js");
    await importDb({
      settings: { tunnelEnabled: true, mitmSudoEncrypted: "obsolete-secret", dnsToolEnabled: { kiro: true } },
      mitmAlias: { kiro: { auto: "cx/gpt-6" } },
      modelAliases: { default: "cx/gpt-6" },
    });
    const backup = await exportDb();
    expect(backup.settings).toEqual({ tunnelEnabled: true });
    expect(backup).not.toHaveProperty("mitmAlias");
    expect(backup.modelAliases).toEqual({ default: "cx/gpt-6" });
  });

  it("fresh DB → applies migrations & stamps schemaVersion", async () => {
    const { getAdapter } = await import("@/lib/db/driver.js");
    const { latestVersion } = await import("@/lib/db/migrations/index.js");
    const db = await getAdapter();
    const row = db.get(`SELECT value FROM _meta WHERE key='schemaVersion'`);
    expect(parseInt(row.value, 10)).toBe(latestVersion());

    const tables = db.all(`SELECT name FROM sqlite_master WHERE type='table'`).map(t => t.name);
    expect(tables).toEqual(expect.arrayContaining([
      "_meta", "settings", "providerConnections", "providerNodes",
      "proxyPools", "notificationChannels", "apiKeys", "combos", "kv",
      "usageHistory", "usageDaily", "requestDetails",
    ]));
  });

  it("existing DB at older schemaVersion → re-applies pending migrations on restart", async () => {
    // 1st boot
    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();
    db.run(`INSERT INTO settings(id, data) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data`, ['{"foo":"bar"}']);
    db.run(`UPDATE _meta SET value = '0' WHERE key = 'schemaVersion'`);
    db.close?.();

    // 2nd boot: full reset to simulate process restart
    delete global._dbAdapter;
    vi.resetModules();
    const { getAdapter: getAdapter2 } = await import("@/lib/db/driver.js");
    const { latestVersion } = await import("@/lib/db/migrations/index.js");
    const db2 = await getAdapter2();
    const row = db2.get(`SELECT value FROM _meta WHERE key='schemaVersion'`);
    expect(parseInt(row.value, 10)).toBe(latestVersion());

    const settings = db2.get(`SELECT data FROM settings WHERE id=1`);
    expect(JSON.parse(settings.data)).toEqual({ foo: "bar" });
  });

  it("fresh DB + legacy db.json → imports data automatically", async () => {
    // Simulate user upgrading: place legacy JSON in DATA_DIR before first boot
    const legacy = {
      settings: { foo: "legacy-value" },
      apiKeys: [{ id: "k1", key: "abc", name: "test", createdAt: new Date().toISOString() }],
      modelAliases: { "gpt-4": "gpt-4-turbo" },
    };
    fs.writeFileSync(path.join(tempDir, "db.json"), JSON.stringify(legacy));

    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();

    const settings = db.get(`SELECT data FROM settings WHERE id=1`);
    expect(JSON.parse(settings.data)).toEqual({ foo: "legacy-value" });

    const keys = db.all(`SELECT * FROM apiKeys`);
    expect(keys).toHaveLength(1);
    expect(keys[0].key).toBe("abc");

    const aliases = db.all(`SELECT * FROM kv WHERE scope='modelAliases'`);
    expect(aliases).toHaveLength(1);
  });

  it("auto-sync re-creates missing index when DB lacks it", async () => {
    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();
    db.exec(`DROP INDEX IF EXISTS idx_pn_type`);
    expect(db.all(`PRAGMA index_list(providerNodes)`).map(i => i.name)).not.toContain("idx_pn_type");
    db.close?.();

    delete global._dbAdapter;
    vi.resetModules();
    const { getAdapter: getAdapter2 } = await import("@/lib/db/driver.js");
    const db2 = await getAdapter2();
    const idx = db2.all(`PRAGMA index_list(providerNodes)`).map(i => i.name);
    expect(idx).toContain("idx_pn_type");
  });
});
