import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let db;
let repo;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "10router-fulldata-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  repo = await import("@/lib/db/repos/requestDetailsRepo.js");
  await db.initDb();
  await db.updateSettings({ enableObservability: true, showSensitiveRequestDetails: true, observabilityBatchSize: 1000 });
});

afterAll(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

const bigRequest = (i) => ({ messages: [{ role: "user", content: `${i}:` + "x".repeat(200 * 1024) }] });

describe("request detail full payload storage", () => {
  it("stores full payloads for the newest 25 rows and clears them on demand", async () => {
    for (let i = 0; i < 30; i++) {
      await db.saveRequestDetail({
        id: `full-${String(i).padStart(2, "0")}`,
        timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
        provider: "openai", model: "gpt-4", status: "ok",
        request: bigRequest(i), response: { ok: true },
      });
    }
    await repo.__test__.flush();

    const { details } = await db.getRequestDetails({ pageSize: 100 });
    const withFull = details.filter((d) => d.hasFullData).map((d) => d.id);
    expect(withFull).toHaveLength(25);
    expect(withFull).not.toContain("full-04");
    expect(withFull).toContain("full-05");

    const full = await db.getRequestDetailFullData("full-29");
    expect(full.request).toEqual(bigRequest(29));
    expect(await db.getRequestDetailFullData("full-00")).toBeNull();

    await db.clearRequestDetailFullData();
    expect(await db.getRequestDetailFullData("full-29")).toBeNull();
  });

  it("reports a corrupt stored payload instead of treating it as missing", async () => {
    const { getAdapter } = await import("@/lib/db/driver.js");
    (await getAdapter()).run(`UPDATE requestDetails SET fullData = 'bm90IGd6aXA=' WHERE id = ?`, ["full-29"]);
    await expect(db.getRequestDetailFullData("full-29")).rejects.toThrow(/corrupt/);
  });
});
