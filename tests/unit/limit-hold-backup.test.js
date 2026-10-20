// Per-key rate-limit overrides must survive a backup and restore.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let tempDir;
const originalDataDir = process.env.DATA_DIR;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "10router-lh-backup-"));
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

describe("api key limitHold backup", () => {
  it("round-trips wait, fail-fast and inherit through export and import", async () => {
    const { importDb, exportDb } = await import("@/lib/db/index.js");
    const { getApiKeyLimitHold } = await import("@/lib/db/repos/apiKeysRepo.js");
    const key = (id, limitHold) => ({ id, key: `sk-${id}`, name: id, isActive: true, limitHold, createdAt: "2026-10-19T00:00:00.000Z" });
    await importDb({ apiKeys: [key("wait", true), key("fast", false), key("inherit", null)] });

    const backup = await exportDb();
    expect(Object.fromEntries(backup.apiKeys.map((k) => [k.id, k.limitHold]))).toEqual({ wait: true, fast: false, inherit: null });

    await importDb(backup);
    expect(await getApiKeyLimitHold("sk-wait")).toBe(true);
    expect(await getApiKeyLimitHold("sk-fast")).toBe(false);
    expect(await getApiKeyLimitHold("sk-inherit")).toBe(null);
  });

  it("treats a backup from before per-key overrides as inherit", async () => {
    const { importDb } = await import("@/lib/db/index.js");
    const { getApiKeyLimitHold } = await import("@/lib/db/repos/apiKeysRepo.js");
    await importDb({ apiKeys: [{ id: "old", key: "sk-old", name: "old", isActive: true }] });
    expect(await getApiKeyLimitHold("sk-old")).toBe(null);
  });
});
