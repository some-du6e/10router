import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "10r-epoch-"));
const originalDataDir = process.env.DATA_DIR;
process.env.DATA_DIR = tempDir;

const db = await import("../../src/lib/db/index.js");
const { getMeta, setMeta } = await import("../../src/lib/db/helpers/metaStore.js");
const { SESSION_EPOCH_META_KEY } = await import("../../src/lib/db/helpers/sessionEpoch.js");

const epoch = () => getMeta(SESSION_EPOCH_META_KEY, null);

afterAll(() => {
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("session epoch across backup and restore", () => {
  it("keeps the epoch out of settings and backups", async () => {
    await setMeta(SESSION_EPOCH_META_KEY, "live-epoch");
    expect(await db.getSettings()).not.toHaveProperty("sessionEpoch");
    expect(JSON.stringify(await db.exportDb())).not.toContain("live-epoch");
  });

  it("keeps the live epoch when a backup with the same password is restored", async () => {
    await db.updateSettings({ password: "$2a$10$same-hash" });
    const backup = await db.exportDb();
    await setMeta(SESSION_EPOCH_META_KEY, "live-epoch");

    await db.importDb(backup);

    expect(await epoch()).toBe("live-epoch");
  });

  it("ignores an epoch smuggled into imported settings", async () => {
    await db.updateSettings({ password: "$2a$10$same-hash" });
    const backup = await db.exportDb();
    await setMeta(SESSION_EPOCH_META_KEY, "live-epoch");

    await db.importDb({ ...backup, settings: { ...backup.settings, sessionEpoch: "old-epoch" } });

    expect(await epoch()).toBe("live-epoch");
  });

  it("starts a new epoch when the import changes the dashboard password", async () => {
    await db.updateSettings({ password: "$2a$10$live-hash" });
    const backup = await db.exportDb();
    await setMeta(SESSION_EPOCH_META_KEY, "live-epoch");

    await db.importDb({ ...backup, settings: { ...backup.settings, password: "$2a$10$other-hash" } });

    const next = await epoch();
    expect(next).not.toBe("live-epoch");
    expect(next).toMatch(/^[0-9a-f]{32}$/);
  });

  it("starts a new epoch when the import has no settings (the password goes with them)", async () => {
    await db.updateSettings({ password: "$2a$10$live-hash" });
    await setMeta(SESSION_EPOCH_META_KEY, "live-epoch");

    await db.importDb({ providerConnections: [] });

    expect(await epoch()).not.toBe("live-epoch");
    expect(await epoch()).not.toBeNull();
  });
});
