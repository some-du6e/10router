// Saves wait in memory until a flush writes them. A queued save holds only its
// capped record; full copies wait in a ring of at most 25 rows; and a flush
// gzips at most those 25, so it keeps up however big the backlog.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import v8 from "node:v8";
import vm from "node:vm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

v8.setFlagsFromString("--expose-gc");
const gc = vm.runInNewContext("gc");

const MAX_RECORDS = 40;
const MB = 1024 * 1024;
const originalDataDir = process.env.DATA_DIR;
let tempDir;
let db;
let repo;
let adapter;
const gzip = vi.fn();
let gate = Promise.resolve();

beforeAll(async () => {
  vi.stubEnv("ENABLE_REQUEST_LOGS", "true");
  vi.stubEnv("OBSERVABILITY_MAX_JSON_SIZE", "");
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "10router-backlog-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  vi.doMock("node:zlib", async (importOriginal) => {
    const zlib = await importOriginal();
    gzip.mockImplementation((input, callback) => { gate.then(() => zlib.gzip(input, callback)); });
    return { ...zlib, gzip };
  });
  db = await import("@/lib/db/index.js");
  repo = await import("@/lib/db/repos/requestDetailsRepo.js");
  await db.initDb();
  adapter = await (await import("@/lib/db/driver.js")).getAdapter();
  // sql.js never stores full copies, so none of this would be exercised.
  if (adapter.driver === "sql.js") throw new Error("request-details-backlog needs a SQLite driver other than sql.js");
  await configure({
    enableObservability: true,
    showSensitiveRequestDetails: true,
    observabilityBatchSize: 1000,
    observabilityFlushIntervalMs: 10 * 60 * 1000,
    observabilityMaxRecords: MAX_RECORDS,
  });
}, 60_000);

afterAll(async () => {
  await repo?.__test__.shutdown();
  vi.doUnmock("node:zlib");
  vi.unstubAllEnvs();
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

// Settings changes take effect once the cached config is dropped.
async function configure(settings) {
  await db.updateSettings(settings);
  await db.clearRequestDetailFullData();
}

// Over the 128 KB cap that applies with full details on, so every save is cut.
const bigRequest = (tag, chars = 200 * 1024) => ({ messages: [{ role: "user", content: `${tag}:` + "x".repeat(chars) }] });
const detail = (id, timestamp, request = bigRequest(id)) => ({ id, timestamp, provider: "openai", model: "gpt-4", status: "ok", request, response: { ok: true } });
const at = (month, second) => new Date(Date.UTC(2026, month, 1, 0, 0, second)).toISOString();
const pad = (n, width = 2) => String(n).padStart(width, "0");
const idsWithFullData = () => adapter.all(`SELECT id FROM requestDetails WHERE fullData IS NOT NULL ORDER BY id`).map((r) => r.id);
const storedIds = () => adapter.all(`SELECT id FROM requestDetails`).map((r) => r.id);

// Saves rows whose request bodies only the repo could hold, and returns
// WeakRefs to those bodies. (A helper, so no caller's frame keeps the last one.)
async function saveTracked(ids, timestampOf) {
  const refs = [];
  for (const id of ids) {
    const request = bigRequest(id);
    refs.push(new WeakRef(request));
    await db.saveRequestDetail(detail(id, timestampOf(id), request));
  }
  return refs;
}

async function aliveAfterGc(refs) {
  await new Promise((resolve) => setTimeout(resolve, 0));
  gc();
  return refs.filter((ref) => ref.deref() !== undefined).length;
}

// Holds every gzip until the returned release runs.
function holdGzip() {
  let release;
  gate = new Promise((resolve) => { release = resolve; });
  return () => { release(); gate = Promise.resolve(); };
}

describe("request detail backlog", { timeout: 120_000 }, () => {
  it("stores the newest 25 rows' full copies, as before", async () => {
    for (let i = 0; i < 60; i++) await db.saveRequestDetail(detail(`row-${pad(i)}`, at(0, i)));
    await repo.__test__.flush();

    expect(idsWithFullData()).toEqual(Array.from({ length: 25 }, (_, i) => `row-${35 + i}`));
    expect((await db.getRequestDetailFullData("row-59")).request).toEqual(bigRequest("row-59"));
    expect(await db.getRequestDetailFullData("row-34")).toBeNull();
    const row = await db.getRequestDetailById("row-59");
    expect(row.request._truncated).toBe(true);
    expect(row.response).toEqual({ ok: true });
  });

  it("gzips at most 25 rows per flush, whatever the backlog", async () => {
    for (let i = 0; i < 150; i++) await db.saveRequestDetail(detail(`many-${pad(i, 3)}`, at(1, i)));
    gzip.mockClear();
    await repo.__test__.flush();
    expect(gzip.mock.calls.length).toBeLessThanOrEqual(25);
    expect(idsWithFullData()).toContain("many-149");
  });

  it("holds no request body once a save returns, with full details on", async () => {
    const refs = await saveTracked(Array.from({ length: 40 }, (_, i) => `held-${pad(i)}`), (id) => at(2, Number(id.slice(5))));
    expect(await aliveAfterGc(refs)).toBe(0);
    expect(repo.__test__.ringSize?.()).toBe(25);
    await repo.__test__.flush();
    expect(idsWithFullData()).toContain("held-39");
  });

  it("keeps the ring within 25 rows and its byte cap", async () => {
    const { limits } = repo.__test__;
    const cap = limits.fullRingMaxBytes;
    limits.fullRingMaxBytes = MB;
    try {
      // Each copy is about 400 KB (2 bytes a char), so two fit.
      for (let i = 0; i < 10; i++) await db.saveRequestDetail(detail(`ring-${pad(i)}`, at(3, i)));
      expect(repo.__test__.ringSize()).toBe(2);
      expect(repo.__test__.ringBytes()).toBeLessThanOrEqual(MB);
      await repo.__test__.flush();
      expect(idsWithFullData().filter((id) => id.startsWith("ring-"))).toEqual(["ring-08", "ring-09"]);
    } finally {
      limits.fullRingMaxBytes = cap;
    }
    for (let i = 0; i < 40; i++) await db.saveRequestDetail(detail(`ring-count-${pad(i)}`, at(3, 20 + i)));
    expect(repo.__test__.ringSize()).toBe(25);
    await repo.__test__.flush();
    expect(repo.__test__.ringSize()).toBe(0);
    expect(repo.__test__.ringBytes()).toBe(0);
  });

  it("lands a stream's end save with its final status, tokens and full copy", async () => {
    const stream = bigRequest("stream");
    const reply = { content: "all done ".repeat(20_000), type: "streaming" };
    await db.saveRequestDetail({ ...detail("stream", at(4, 0), stream), status: "pending", response: { content: "[Streaming in progress...]" }, tokens: { prompt_tokens: 0, completion_tokens: 0 } });
    // The end save replaces the start save's copy.
    await db.saveRequestDetail({ ...detail("stream", at(4, 1), stream), status: "ok", providerResponse: reply, response: reply, tokens: { prompt_tokens: 10, completion_tokens: 5 } });
    expect(repo.__test__.ringSize()).toBe(1);
    await repo.__test__.flush();

    const row = await db.getRequestDetailById("stream");
    expect(row.status).toBe("ok");
    expect(row.tokens).toEqual({ prompt_tokens: 10, completion_tokens: 5 });
    expect(row.hasFullData).toBe(true);
    expect(await db.getRequestDetailFullData("stream")).toEqual({ request: stream, providerResponse: reply, response: reply });
  });

  it("caps the queue by count, dropping the oldest saves, while a write is stuck", async () => {
    const release = holdGzip();
    let flushing;
    try {
      await db.saveRequestDetail(detail("slow-000", at(5, 0)));
      gzip.mockClear();
      flushing = repo.__test__.flush();
      await vi.waitFor(() => expect(gzip).toHaveBeenCalledTimes(1));
      for (let i = 1; i <= 200; i++) await db.saveRequestDetail(detail(`slow-${pad(i, 3)}`, at(5, i)));
      expect(repo.__test__.queued()).toBe(2 * MAX_RECORDS);
    } finally {
      release();
      await flushing?.catch(() => {});
    }
    expect(repo.__test__.queued()).toBe(0);
    const ids = adapter.all(`SELECT id FROM requestDetails ORDER BY timestamp DESC`).map((r) => r.id);
    expect(ids).toHaveLength(MAX_RECORDS);
    expect(ids[0]).toBe("slow-200");
    expect(ids[MAX_RECORDS - 1]).toBe("slow-161");
  });

  it("caps the queue by bytes, dropping the oldest saves, while a write is stuck", async () => {
    const { limits } = repo.__test__;
    const cap = limits.queuedRecordsMaxBytes;
    const release = holdGzip();
    let flushing;
    try {
      await db.saveRequestDetail(detail("bytes-000", at(6, 0)));
      gzip.mockClear();
      flushing = repo.__test__.flush();
      await vi.waitFor(() => expect(gzip).toHaveBeenCalledTimes(1));
      // Room for five records of this size.
      await db.saveRequestDetail(detail("bytes-001", at(6, 1)));
      const limit = 5 * repo.__test__.queuedBytes();
      limits.queuedRecordsMaxBytes = limit;
      for (let i = 2; i <= 30; i++) await db.saveRequestDetail(detail(`bytes-${pad(i, 3)}`, at(6, i)));
      expect(repo.__test__.queuedBytes()).toBeLessThanOrEqual(limit);
      expect(repo.__test__.queued()).toBeGreaterThan(0);
      expect(repo.__test__.queued()).toBeLessThan(30);
    } finally {
      release();
      await flushing?.catch(() => {});
      limits.queuedRecordsMaxBytes = cap;
    }
    expect(storedIds()).toContain("bytes-030");
    expect(storedIds()).not.toContain("bytes-001");
  });

  it("holds no request body while full details are off", async () => {
    await configure({ showSensitiveRequestDetails: false });
    try {
      const refs = await saveTracked(Array.from({ length: 30 }, (_, i) => `off-${pad(i)}`), (id) => at(7, Number(id.slice(4))));
      expect(await aliveAfterGc(refs)).toBe(0);
      expect(repo.__test__.ringSize()).toBe(0);
      expect(repo.__test__.queued()).toBe(30);
      await repo.__test__.flush();
      expect((await db.getRequestDetailById("off-29")).request._truncated).toBe(true);
      expect(await db.getRequestDetailFullData("off-29")).toBeNull();
    } finally {
      await configure({ showSensitiveRequestDetails: true });
    }
  });

  it("clears the ring when full details are turned off", async () => {
    for (let i = 0; i < 5; i++) await db.saveRequestDetail(detail(`toggle-${i}`, at(8, i)));
    expect(repo.__test__.ringSize()).toBe(5);
    await configure({ showSensitiveRequestDetails: false });
    expect(repo.__test__.ringSize()).toBe(0);
    expect(repo.__test__.ringBytes()).toBe(0);
    await repo.__test__.flush();
    expect(await db.getRequestDetailFullData("toggle-4")).toBeNull();
    await configure({ showSensitiveRequestDetails: true });
  });

  it("writes the saves left behind a failed write without another save", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.resetModules();
    const fresh = await import("@/lib/db/repos/requestDetailsRepo.js");
    await db.updateSettings({ observabilityBatchSize: 2 });
    await fresh.clearRequestDetailFullData();
    const failOnce = vi.spyOn(adapter, "transaction").mockImplementationOnce(() => { throw new Error("disk full"); });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const release = holdGzip();
    let flushing;
    try {
      // The second save reaches the batch size and starts a write, held while it compresses.
      await fresh.saveRequestDetail(detail("fail-a", at(9, 0)));
      await fresh.saveRequestDetail(detail("fail-b", at(9, 1)));
      flushing = fresh.__test__.flush();
      // Two more saves wait behind it; the second cancels the timer the first armed.
      await fresh.saveRequestDetail(detail("left-c", at(9, 2), { messages: [] }));
      await fresh.saveRequestDetail(detail("left-d", at(9, 3), { messages: [] }));
      release();
      await flushing;
      expect(consoleError).toHaveBeenCalledWith("[requestDetailsRepo] Batch write failed:", expect.any(Error));
      expect(storedIds()).not.toContain("left-c");

      // Only the re-armed timer can write them now.
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
      await vi.waitFor(() => expect(storedIds()).toEqual(expect.arrayContaining(["left-c", "left-d"])), { timeout: 5000 });
    } finally {
      release();
      await flushing?.catch(() => {});
      failOnce.mockRestore();
      consoleError.mockRestore();
      vi.useRealTimers();
      await fresh.__test__.shutdown();
      await configure({ observabilityBatchSize: 1000 });
    }
  });
});
