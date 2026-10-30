import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let db;
let repo;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "10router-error-class-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  repo = await import("@/lib/db/repos/requestDetailsRepo.js");
  await db.initDb();
});

afterAll(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

const failureRow = (id) => ({
  id,
  provider: "anthropic",
  model: "claude-opus-5-5",
  status: "error",
  latency: { ttft: 612, total: 630 },
  request: { messages: [{ role: "user", content: "hi" }] },
  response: { error: "rate_limit_error", status: 429 },
  errorClass: "rate_limited",
});

describe("requestDetails persistence", () => {
  it.each([
    ["full data off", false],
    ["full data on", true],
  ])("keeps errorClass and the measured ttft on a saved failure row (%s)", async (_name, keepFull) => {
    await db.updateSettings({ enableObservability: true, showSensitiveRequestDetails: keepFull, observabilityBatchSize: 1000 });
    const id = `row-429-${keepFull ? "full" : "plain"}`;
    await db.saveRequestDetail(failureRow(id));
    await repo.__test__.flush();

    const row = await db.getRequestDetailById(id);
    expect(row.errorClass).toBe("rate_limited");
    expect(row.latency).toEqual({ ttft: 612, total: 630 });
  });
});
