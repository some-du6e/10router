import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
const originalBatch = process.env.OBSERVABILITY_BATCH_SIZE;
const originalLogs = process.env.ENABLE_REQUEST_LOGS;
let tempDir;

afterEach(() => {
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  if (originalBatch === undefined) delete process.env.OBSERVABILITY_BATCH_SIZE;
  else process.env.OBSERVABILITY_BATCH_SIZE = originalBatch;
  if (originalLogs === undefined) delete process.env.ENABLE_REQUEST_LOGS;
  else process.env.ENABLE_REQUEST_LOGS = originalLogs;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("requestDetails persistence", () => {
  it("keeps errorClass and the measured ttft on a saved failure row", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "10router-error-class-"));
    process.env.DATA_DIR = tempDir;
    process.env.OBSERVABILITY_BATCH_SIZE = "1";
    process.env.ENABLE_REQUEST_LOGS = "true";
    vi.resetModules();
    const repo = await import("../../src/lib/db/repos/requestDetailsRepo.js");

    await repo.saveRequestDetail({
      id: "row-429",
      provider: "anthropic",
      model: "claude-opus-5-5",
      status: "error",
      latency: { ttft: 612, total: 630 },
      response: { error: "rate_limit_error", status: 429 },
      errorClass: "rate_limited",
    });

    let row = null;
    // Settings defaults batch writes behind a ~5s flush timer, so poll past it.
    for (let i = 0; i < 80 && !row; i++) {
      await new Promise((r) => setTimeout(r, 100));
      row = await repo.getRequestDetailById("row-429");
    }
    expect(row.errorClass).toBe("rate_limited");
    expect(row.latency).toEqual({ ttft: 612, total: 630 });
  }, 20000);
});
