// A streaming request is saved twice under one id: when the stream starts and
// when it ends. The second save must store exactly what a cold save would,
// without capping the ~1 MB request bodies a second time, and without the
// stream holding those bodies until it ends: it stores the records the first
// save capped.
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

describe("a streaming row's end save", () => {
  it("stores the records the start save capped, not the request bodies", async () => {
    vi.resetModules();
    // As the repository does with full details off: resolves to the capped records.
    const capped = { request: { _truncated: true, _preview: "req" }, providerRequest: { _truncated: true, _preview: "prov" } };
    const saveRequestDetail = vi.fn(() => Promise.resolve(capped));
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
    const { onStreamComplete, streamDetail } = buildOnStreamComplete(ctx);
    const streamDetailId = streamDetail.id;
    const controller = { signal: new AbortController().signal, isConnected: () => true, handleComplete: vi.fn(), handleError: vi.fn(), handleDisconnect: vi.fn() };
    await handleStreamingResponse({
      ...ctx, providerResponse: new Response("", { headers: { "content-type": "text/event-stream" } }),
      sourceFormat: "claude", targetFormat: "claude", streamController: controller, onStreamComplete, streamDetail,
    });
    onStreamComplete({ content: "hi", thinking: "", toolCalls: [] }, { prompt_tokens: 1, completion_tokens: 1 }, Date.now());

    // The empty test stream also ends by itself: that is an end save too.
    await vi.waitFor(() => expect(saveRequestDetail.mock.calls.some(([d]) => d.response?.content === "hi")).toBe(true));
    const [start, ...ends] = saveRequestDetail.mock.calls.map(([detail]) => detail);
    expect(start.id).toBe(streamDetailId);
    expect(start.request).toEqual(extractRequestConfig(body, true));
    expect(start.providerRequest).toBe(translatedBody);
    for (const end of ends) {
      expect(end.id).toBe(streamDetailId);
      expect(end.request).toBe(capped.request);
      expect(end.providerRequest).toBe(capped.providerRequest);
    }
    expect(ends.map((end) => end.response.content)).toContain("hi");
    vi.doUnmock("@/lib/usageDb.js");
  }, 30_000);

  it("waits for a start save still being built", async () => {
    vi.resetModules();
    let resolveStart;
    const capped = { request: { _truncated: true }, providerRequest: null };
    const saveRequestDetail = vi.fn()
      .mockImplementationOnce(() => new Promise((resolve) => { resolveStart = () => resolve(capped); }))
      .mockImplementation(() => Promise.resolve(null));
    vi.doMock("@/lib/usageDb.js", () => ({
      saveRequestDetail,
      saveRequestUsage: vi.fn(() => Promise.resolve()),
      appendRequestLog: vi.fn(() => Promise.resolve()),
      trackPendingRequest: vi.fn(),
    }));
    const { streamDetailRow } = await import("../../open-sse/handlers/chatCore/requestDetail.js");
    const row = streamDetailRow("row-1");
    row.start({ request: big("x"), providerRequest: big("y"), response: { content: "…" } });
    const finished = row.finish({ response: { content: "done" } });
    await Promise.resolve();
    expect(saveRequestDetail).toHaveBeenCalledTimes(1);
    resolveStart();
    await finished;
    expect(saveRequestDetail).toHaveBeenCalledTimes(2);
    expect(saveRequestDetail.mock.calls[1][0]).toMatchObject({ id: "row-1", request: capped.request, providerRequest: null, response: { content: "done" } });
    vi.doUnmock("@/lib/usageDb.js");
  }, 30_000);
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

  it("does not cap the request bodies again on the second save, and packs them once at its write", async () => {
    const request = big("s");
    const providerRequest = big("t");
    await db.saveRequestDetail(detail("twice", request, providerRequest, progress));
    await repo.__test__.flush();
    // The start save was already written, so the end save's copy is packed again.
    const stringify = vi.spyOn(JSON, "stringify");
    const bodies = () => stringify.mock.calls.filter(([value]) => value === request || value === providerRequest).length;
    let atSave;
    let atWrite;
    try {
      await db.saveRequestDetail(detail("twice", request, providerRequest, done));
      atSave = bodies();
      gzip.mockClear();
      await repo.__test__.flush();
      atWrite = bodies() - atSave;
    } finally {
      stringify.mockRestore();
    }
    expect(atSave).toBe(0);
    expect(atWrite).toBe(2);
    expect(gzip).toHaveBeenCalledTimes(1);
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

  // The end save as a stream makes it: with what its start save handed back
  // for the request payloads (streamDetailRow).
  const endSave = (id, start, response, timestamp) => db.saveRequestDetail({ ...detail(id, start.request, start.providerRequest, response), ...(timestamp && { timestamp }) });

  // The trim keeps full copies on the newest 25 rows: a long stream's start
  // copy is gone by its end, so the end save rebuilds it from the bodies.
  it("with full details on, hands back the bodies, so a long stream's end row gets its full copy back", async () => {
    const request = big("c");
    const providerRequest = { ...big("d"), system: "be brief" };
    const start = await db.saveRequestDetail({ ...detail("long-stream", request, providerRequest, progress), timestamp: "2026-01-01T00:00:00.000Z" });
    expect(start.request).toBe(request);
    expect(start.providerRequest).toBe(providerRequest);
    await repo.__test__.flush();
    for (let i = 0; i < 26; i++) await db.saveRequestDetail({ ...detail(`newer-${i}`, big(`n${i}`), null, done), timestamp: "2026-01-01T00:00:01.000Z" });
    await repo.__test__.flush();
    expect(row("long-stream").fullData).toBeNull();

    await endSave("long-stream", start, done, "2026-01-01T00:00:02.000Z");
    await repo.__test__.flush();
    expect(await db.getRequestDetailFullData("long-stream")).toEqual({ request, providerRequest });
  });

  it("with full details on, hands back the capped records when the payloads are too big for a full copy", async () => {
    const { limits } = repo.__test__;
    const ringMax = limits.fullRingMaxBytes;
    limits.fullRingMaxBytes = 1024;
    let start;
    try {
      start = await db.saveRequestDetail(detail("too-big", big("i"), big("j"), progress));
    } finally {
      limits.fullRingMaxBytes = ringMax;
    }
    expect(start.request._truncated).toBe(true);
    expect(start.providerRequest._truncated).toBe(true);
  });

  describe("with full details off", () => {
    beforeAll(async () => {
      await db.updateSettings({ showSensitiveRequestDetails: false });
      await db.clearRequestDetailFullData();
    });
    afterAll(async () => {
      await db.updateSettings({ showSensitiveRequestDetails: true });
      await db.clearRequestDetailFullData();
    });

    it("hands back the capped records, and an end save of them stores what a cold save would", async () => {
      const request = big("e");
      const providerRequest = big("f");
      const start = await db.saveRequestDetail(detail("carried", request, providerRequest, progress));
      expect(start.request._truncated).toBe(true);
      expect(start.providerRequest._truncated).toBe(true);
      await endSave("carried", start, done);
      await repo.__test__.flush();
      await db.saveRequestDetail(detail("carried-cold", structuredClone(request), structuredClone(providerRequest), done));
      await repo.__test__.flush();
      expect(row("carried").data).toBe(row("carried-cold").data.replace('"id":"carried-cold"', '"id":"carried"'));
      expect(row("carried").fullData).toBeNull();
    });

    it("stores a capped record as it is when the size limit shrank since", async () => {
      const start = await db.saveRequestDetail(detail("shrunk", big("g"), big("h"), progress));
      await db.updateSettings({ observabilityMaxJsonSize: 2 });
      await db.clearRequestDetailFullData();
      try {
        await endSave("shrunk", start, done);
        await repo.__test__.flush();
      } finally {
        await db.updateSettings({ observabilityMaxJsonSize: 0 });
        await db.clearRequestDetailFullData();
      }
      const stored = JSON.parse(row("shrunk").data);
      expect(stored.request).toEqual(start.request);
      expect(stored.request._preview).toContain('"messages"');
    });
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
});
