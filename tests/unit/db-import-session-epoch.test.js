import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "10r-epoch-"));
const originalDataDir = process.env.DATA_DIR;
process.env.DATA_DIR = tempDir;

const db = await import("../../src/lib/db/index.js");

afterAll(() => {
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("session epoch across backup and restore", () => {
  it("leaves the epoch out of exports and keeps the live one on import", async () => {
    await db.updateSettings({ sessionEpoch: "old-epoch" });
    const backup = await db.exportDb();
    expect(backup.settings).not.toHaveProperty("sessionEpoch");

    await db.updateSettings({ sessionEpoch: "live-epoch" });
    await db.importDb({ ...backup, settings: { ...backup.settings, sessionEpoch: "old-epoch" } });

    expect((await db.getSettings()).sessionEpoch).toBe("live-epoch");
  });
});
