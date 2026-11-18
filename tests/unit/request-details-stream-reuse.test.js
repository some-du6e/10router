// A streaming request is saved twice under one id: when the stream starts and
// when it ends. The second save must store exactly what a cold save would,
// without capping the ~1 MB request bodies a second time.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const big = (tag) => ({
  model: "claude-opus-5-5",
  stream: true,
  messages: Array.from({ length: 40 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: [{ type: "text", text: `${tag}${i}:` + "lorem ipsum ".repeat(600) }] })),
  tools: [{ name: "Read", description: "read a file", input_schema: { type: "object", properties: { path: { type: "string" } } } }],
});

describe("streaming saves share one request object", () => {
  it("passes the same request config to the start and the complete row", async () => {
    vi.resetModules();
    const saveRequestDetail = vi.fn(() => Promise.resolve());
    vi.doMock("@/lib/usageDb.js", () => ({
      saveRequestDetail,
      saveRequestUsage: vi.fn(() => Promise.resolve()),
      appendRequestLog: vi.fn(() => Promise.resolve()),
      trackPendingRequest: vi.fn(),
    }));
    const { handleStreamingResponse, buildOnStreamComplete } = await import("../../open-sse/handlers/chatCore/streamingHandler.js");
    const { extractRequestConfig } = await import("../../open-sse/handlers/chatCore/requestDetail.js");
    const body = big("b");
    const translatedBody = { ...body, model: "claude-opus-5-5" };
    const ctx = { provider: "anthropic", model: "claude-opus-5-5", body, stream: true, translatedBody, requestStartTime: Date.now() };
    const { onStreamComplete, streamDetailId, streamRequest } = buildOnStreamComplete(ctx);
    const controller = { signal: new AbortController().signal, isConnected: () => true, handleComplete: vi.fn(), handleError: vi.fn(), handleDisconnect: vi.fn() };
    await handleStreamingResponse({
      ...ctx, providerResponse: new Response("", { headers: { "content-type": "text/event-stream" } }),
      sourceFormat: "claude", targetFormat: "claude", streamController: controller, onStreamComplete, streamDetailId, streamRequest,
    });
    onStreamComplete({ content: "hi", thinking: "", toolCalls: [] }, { prompt_tokens: 1, completion_tokens: 1 }, Date.now());

    expect(saveRequestDetail).toHaveBeenCalledTimes(2);
    const [start, end] = saveRequestDetail.mock.calls.map(([detail]) => detail);
    expect(start.id).toBe(streamDetailId);
    expect(end.id).toBe(streamDetailId);
    expect(end.request).toBe(start.request);
    expect(start.request).toEqual(extractRequestConfig(body, true));
    expect(end.providerRequest).toBe(start.providerRequest);
    vi.doUnmock("@/lib/usageDb.js");
  });
});

describe("request detail capping on a repeated save", () => {
  const originalDataDir = process.env.DATA_DIR;
  let tempDir;
  let db;
  let repo;
  let adapter;
  const gzip = vi.fn();

  beforeAll(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "10router-stream-reuse-"));
    process.env.DATA_DIR = tempDir;
    vi.resetModules();
    vi.doMock("node:zlib", async (importOriginal) => {
      const zlib = await importOriginal();
      gzip.mockImplementation((...args) => zlib.gzip(...args));
      return { ...zlib, gzip };
    });
    db = await import("@/lib/db/index.js");
    repo = await import("@/lib/db/repos/requestDetailsRepo.js");
    await db.initDb();
    await db.updateSettings({ enableObservability: true, showSensitiveRequestDetails: true, observabilityBatchSize: 1000 });
    adapter = await (await import("@/lib/db/driver.js")).getAdapter();
  });

  afterAll(() => {
    vi.doUnmock("node:zlib");
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
  });

  const row = (id) => adapter.get(`SELECT data, fullData FROM requestDetails WHERE id = ?`, [id]);
  const detail = (id, request, providerRequest, response) => ({
    id, timestamp: "2026-01-01T00:00:00.000Z", provider: "anthropic", model: "claude-opus-5-5", status: "success",
    request, providerRequest, providerResponse: response, response,
  });
  const progress = { content: "[Streaming in progress...]", thinking: null, type: "streaming" };
  const done = { content: "all done", thinking: null, tool_calls: [], type: "streaming" };

  it("stores the complete row byte for byte as a cold save would", async () => {
    const request = big("r");
    const providerRequest = { ...big("p"), system: "be brief" };
    await db.saveRequestDetail(detail("warm", request, providerRequest, progress));
    await repo.__test__.flush();
    await db.saveRequestDetail(detail("warm", request, providerRequest, done));
    await repo.__test__.flush();
    await db.saveRequestDetail(detail("cold", structuredClone(request), structuredClone(providerRequest), done));
    await repo.__test__.flush();

    const warm = row("warm");
    const cold = row("cold");
    expect(warm.data).toBe(cold.data.replace('"id":"cold"', '"id":"warm"'));
    expect(JSON.parse(warm.data).request._truncated).toBe(true);
    expect(JSON.parse(warm.data).response.content).toBe("all done");
    expect(warm.fullData).toBe(cold.fullData);
    expect(await db.getRequestDetailFullData("warm")).toEqual({ request, providerRequest });
  });

  it("does not serialize or compress the request bodies again on the second save", async () => {
    const request = big("s");
    const providerRequest = big("t");
    await db.saveRequestDetail(detail("twice", request, providerRequest, progress));
    await repo.__test__.flush();
    await db.saveRequestDetail(detail("twice", request, providerRequest, done));
    const stringify = vi.spyOn(JSON, "stringify");
    gzip.mockClear();
    await repo.__test__.flush();
    const again = stringify.mock.calls.filter(([value]) => value === request || value === providerRequest).length;
    stringify.mockRestore();
    expect(again).toBe(0);
    expect(gzip).not.toHaveBeenCalled();
    expect(await db.getRequestDetailFullData("twice")).toEqual({ request, providerRequest });
  });

  it("packs the full copy again when the complete row cut one more field", async () => {
    const request = big("v");
    const providerRequest = big("w");
    await db.saveRequestDetail(detail("long-reply", request, providerRequest, progress));
    await repo.__test__.flush();
    const reply = { content: "x".repeat(200 * 1024), thinking: null, tool_calls: [], type: "streaming" };
    await db.saveRequestDetail(detail("long-reply", request, providerRequest, reply));
    gzip.mockClear();
    await repo.__test__.flush();
    expect(gzip).toHaveBeenCalledTimes(1);
    expect(await db.getRequestDetailFullData("long-reply")).toEqual({ request, providerRequest, providerResponse: reply, response: reply });
  });

  it("caps again when the size limit changed", () => {
    const { truncateField } = repo.__test__;
    const obj = big("u");
    const first = truncateField(obj, 5 * 1024);
    expect(truncateField(obj, 10 * 1024)).toEqual(truncateField(structuredClone(obj), 10 * 1024));
    expect(truncateField(obj, 10 * 1024)).not.toEqual(first);

    const capped = truncateField(obj, 10 * 1024);
    expect(truncateField(obj, 10 * 1024)).toBe(capped);
  });

  it("does not keep a body's JSON alive after capping it", () => {
    const { truncateField } = repo.__test__;
    const obj = big("x");
    const first = {};
    const capped = truncateField(obj, 10 * 1024, first, "request");
    expect(first.request).toBe(JSON.stringify(obj));
    const again = {};
    expect(truncateField(obj, 10 * 1024, again, "request")).toBe(capped);
    expect(again.request).toBeUndefined();
  });
});
