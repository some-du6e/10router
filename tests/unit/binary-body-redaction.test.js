import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

// Windsurf's upstream body is protobuf whose first field is the API key.
const KEY = "ws-api-key-placeholder-0001";
const protobufBody = () => new Uint8Array([0x0a, KEY.length, ...Buffer.from(KEY), 0x12, 0x01, 0x61]);

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "10r-binary-"));
const originalDataDir = process.env.DATA_DIR;

afterAll(() => {
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  delete process.env.ENABLE_REQUEST_LOGS;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("binary upstream bodies", () => {
  it("the request log writes their size, never their bytes", async () => {
    const cwd = fs.mkdtempSync(path.join(tempDir, "logs-"));
    vi.resetModules();
    process.env.ENABLE_REQUEST_LOGS = "true";
    const spy = vi.spyOn(process, "cwd").mockReturnValue(cwd);
    try {
      const { createRequestLogger } = await import("../../open-sse/utils/requestLogger.js");
      const logger = await createRequestLogger("openai", "windsurf", "m");
      const body = protobufBody();
      logger.logTargetRequest("https://upstream.example/rpc", {}, body);
      logger.logError(new Error("boom"), Buffer.from(body));
      const target = fs.readFileSync(path.join(logger.sessionPath, "4_req_target.json"), "utf8");
      const error = fs.readFileSync(path.join(logger.sessionPath, "6_error.json"), "utf8");
      expect(target).not.toContain(KEY);
      expect(JSON.parse(target).body).toBe(`[binary ${body.byteLength} bytes]`);
      expect(error).not.toContain(KEY);
      expect(JSON.parse(error).requestBody).toBe(`[binary ${body.byteLength} bytes]`);
    } finally {
      spy.mockRestore();
      delete process.env.ENABLE_REQUEST_LOGS;
    }
  });

  it("request details store their size as providerRequest", async () => {
    vi.resetModules();
    process.env.DATA_DIR = path.join(tempDir, "data");
    delete process.env.ENABLE_REQUEST_LOGS;
    const db = await import("../../src/lib/db/index.js");
    const repo = await import("../../src/lib/db/repos/requestDetailsRepo.js");
    await db.initDb();
    await db.updateSettings({ enableObservability: true, observabilityBatchSize: 1000 });
    const body = protobufBody();
    await repo.saveRequestDetail({ id: "detail-binary-1", provider: "windsurf", model: "m", status: 200, providerRequest: body, request: { body: {} } });
    await repo.__test__.flush();
    const stored = await repo.getRequestDetailById("detail-binary-1");
    expect(stored).toBeTruthy();
    expect(JSON.stringify(stored)).not.toContain(KEY);
    expect(stored.providerRequest).toBe(`[binary ${body.byteLength} bytes]`);
  });
});
