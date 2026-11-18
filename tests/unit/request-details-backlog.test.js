// Saves wait in memory until a flush writes them. A flush must keep up with the
// requests feeding it, and whatever the backlog, only a few saves may hold the
// JSON of a whole body, within a byte budget, and none may hold the body itself.
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
    // 16 KB capped fields keep the queued records small next to the bodies.
    observabilityMaxJsonSize: 16,
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

const bigRequest = (tag, chars = 200 * 1024) => ({ messages: [{ role: "user", content: `${tag}:` + "x".repeat(chars) }] });
const detail = (id, timestamp, request = bigRequest(id)) => ({ id, timestamp, provider: "openai", model: "gpt-4", status: "ok", request, response: { ok: true } });
const at = (month, second) => new Date(Date.UTC(2026, month, 1, 0, 0, second)).toISOString();
const pad = (n, width = 2) => String(n).padStart(width, "0");
const idsWithFullData = () => adapter.all(`SELECT id FROM requestDetails WHERE fullData IS NOT NULL ORDER BY id`).map((r) => r.id);
const storedIds = () => adapter.all(`SELECT id FROM requestDetails`).map((r) => r.id);
// The row each gzip call packed, read from the tag its request body starts with.
const gzippedIds = () => gzip.mock.calls.map(([input]) => JSON.parse(String(input)).request.messages[0].content.split(":")[0]);
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

// Saves rows whose bodies only the repo can hold, and returns WeakRefs to them.
async function saveTracked(ids, timestampOf, chars) {
  const refs = [];
  for (const id of ids) {
    const request = bigRequest(id, chars);
    refs.push(new WeakRef(request));
    await db.saveRequestDetail(detail(id, timestampOf(id), request));
  }
  return refs;
}

async function aliveAfterGc(refs) {
  await tick();
  gc();
  return refs.filter((ref) => ref.deref() !== undefined).length;
}

async function heapAfterGc() {
  await tick();
  gc();
  gc();
  return process.memoryUsage().heapUsed;
}

// Holds every gzip until the returned release runs.
function holdGzip() {
  let release;
  gate = new Promise((resolve) => { release = resolve; });
  return () => { release(); gate = Promise.resolve(); };
}

describe("request detail backlog", { timeout: 120_000 }, () => {
  it("packs full copies only for the rows the table keeps them on", async () => {
    for (let i = 0; i < 60; i++) await db.saveRequestDetail(detail(`row-${pad(i)}`, at(0, i)));
    gzip.mockClear();
    await repo.__test__.flush();

    expect(gzip).toHaveBeenCalledTimes(25);
    expect(idsWithFullData()).toEqual(Array.from({ length: 25 }, (_, i) => `row-${35 + i}`));
    expect((await db.getRequestDetailFullData("row-59")).request).toEqual(bigRequest("row-59"));
    expect(await db.getRequestDetailFullData("row-34")).toBeNull();
  });

  it("packs exactly the rows the trim keeps, a timestamp tie and a stream's late end save included", async () => {
    gzip.mockClear();
    const stream = bigRequest("stream");
    await db.saveRequestDetail(detail("stream", at(1, 1), stream));
    for (let i = 0; i < 30; i++) await db.saveRequestDetail(detail(`r${pad(i)}`, at(1, i)));
    await db.saveRequestDetail(detail("tie-a", at(1, 6)));
    await db.saveRequestDetail(detail("tie-b", at(1, 6)));
    // The stream ends last, under its start save's id and with the same body.
    const stringify = vi.spyOn(JSON, "stringify");
    await db.saveRequestDetail(detail("stream", at(1, 59), stream));
    await repo.__test__.flush();
    const serializedAgain = stringify.mock.calls.filter(([value]) => value === stream).length;
    stringify.mockRestore();

    const packed = gzippedIds();
    expect(packed).toHaveLength(25);
    expect(packed.filter((id) => id === "stream")).toHaveLength(1);
    expect([...packed].sort()).toEqual(idsWithFullData());
    expect(idsWithFullData()).toContain("tie-b");
    expect(idsWithFullData()).not.toContain("tie-a");
    // The end save is packed from the start save's JSON.
    expect(serializedAgain).toBe(0);
    expect((await db.getRequestDetailFullData("stream")).request).toEqual(stream);
  });

  it("caps the saves waiting behind a slow flush", async () => {
    const release = holdGzip();
    let flushing;
    try {
      await db.saveRequestDetail(detail("slow-000", at(2, 0)));
      flushing = repo.__test__.flush();
      for (let i = 1; i <= 200; i++) await db.saveRequestDetail(detail(`slow-${pad(i, 3)}`, at(2, i)));
      expect(repo.__test__.buffered()).toBe(2 * MAX_RECORDS);
    } finally {
      release();
      await flushing?.catch(() => {});
    }
    expect(repo.__test__.buffered()).toBe(0);
    const ids = adapter.all(`SELECT id FROM requestDetails ORDER BY timestamp DESC`).map((r) => r.id);
    expect(ids).toHaveLength(MAX_RECORDS);
    expect(ids[0]).toBe("slow-200");
    expect(ids[MAX_RECORDS - 1]).toBe("slow-161");
  });

  it("holds no body and at most MAX_FULL_CANDIDATES+1 saves' JSON while a flush is stuck", async () => {
    // Enough rows that the row cap keeps all 190 saves: only the JSON window limits them.
    await configure({ observabilityMaxRecords: 200 });
    const BODY = MB;
    const before = await heapAfterGc();
    const release = holdGzip();
    let flushing;
    let refs = [];
    try {
      // A flush takes 120 saves and gets stuck compressing the newest, which it packs first.
      refs = await saveTracked(Array.from({ length: 120 }, (_, i) => `held-${pad(i, 3)}`), (id) => at(3, Number(id.slice(5))), BODY);
      gzip.mockClear();
      flushing = repo.__test__.flush();
      await vi.waitFor(() => expect(gzip).toHaveBeenCalledTimes(1));
      // 70 more saves arrive behind it.
      refs.push(...await saveTracked(Array.from({ length: 70 }, (_, i) => `late-${pad(i, 3)}`), (id) => at(4, Number(id.slice(5))), BODY));

      const max = repo.__test__.MAX_FULL_CANDIDATES ?? 58;
      // No save holds its body; base code held all 190.
      expect(await aliveAfterGc(refs)).toBeLessThanOrEqual(max + 1);
      expect(await aliveAfterGc(refs)).toBe(0);
      // What is held is the JSON of the window's saves and of the one being
      // compressed, plus small capped records.
      const grown = (await heapAfterGc()) - before;
      expect(grown).toBeLessThan((max + 1) * BODY * 1.25 + 190 * 64 * 1024 + 24 * MB);

      expect(repo.__test__.fullCandidates?.()).toBe(max);
      // The +1: the stuck write packs its newest row, whose save has left the window.
      expect(gzippedIds()).toEqual(["held-119"]);
      expect(repo.__test__.fullCandidateBytes?.()).toBeLessThanOrEqual(max * 2 * (BODY + 64 * 1024));
    } finally {
      release();
      await flushing?.catch(() => {});
    }
    gzip.mockClear();
    expect(repo.__test__.fullCandidates()).toBe(0);
    expect(repo.__test__.fullCandidateBytes()).toBe(0);
    expect(await aliveAfterGc(refs)).toBe(0);
    expect((await heapAfterGc()) - before).toBeLessThan(24 * MB);
    expect(idsWithFullData()).toContain("late-069");
  });

  it("keeps the saved JSON within its byte budget, oldest dropped first", async () => {
    const { limits } = repo.__test__;
    const budget = limits.fullCandidatesMaxBytes;
    limits.fullCandidatesMaxBytes = MB;
    try {
      // Each save holds about 400 KB of JSON (2 bytes a char), so two fit.
      for (let i = 0; i < 10; i++) await db.saveRequestDetail(detail(`budget-${pad(i)}`, at(5, i)));
      expect(repo.__test__.fullCandidates()).toBe(2);
      expect(repo.__test__.fullCandidateBytes()).toBeLessThanOrEqual(MB);
      gzip.mockClear();
      await repo.__test__.flush();
      expect([...gzippedIds()].sort()).toEqual(["budget-08", "budget-09"]);
    } finally {
      limits.fullCandidatesMaxBytes = budget;
    }
  });

  it("keeps no JSON for a save over the full copy limit", async () => {
    await db.saveRequestDetail(detail("huge", at(6, 0), bigRequest("huge", 17 * MB)));
    expect(repo.__test__.fullCandidates()).toBe(0);
    expect(repo.__test__.fullCandidateBytes()).toBe(0);
    await repo.__test__.flush();
    expect((await db.getRequestDetailById("huge")).request._truncated).toBe(true);
    expect(await db.getRequestDetailFullData("huge")).toBeNull();
  });

  it("keeps the waiting records within their byte budget, a running write's included", async () => {
    const { limits } = repo.__test__;
    const budget = limits.queuedRecordsMaxBytes;
    limits.queuedRecordsMaxBytes = 300 * 1024;
    const release = holdGzip();
    let flushing;
    try {
      await db.saveRequestDetail(detail("queue-000", at(7, 0)));
      flushing = repo.__test__.flush();
      for (let i = 1; i <= 40; i++) await db.saveRequestDetail(detail(`queue-${pad(i, 3)}`, at(7, i)));
      expect(repo.__test__.queuedBytes()).toBeLessThanOrEqual(300 * 1024);
      expect(repo.__test__.buffered()).toBeGreaterThan(0);
      expect(repo.__test__.buffered()).toBeLessThan(40);
    } finally {
      release();
      await flushing?.catch(() => {});
      limits.queuedRecordsMaxBytes = budget;
    }
    expect(storedIds()).toContain("queue-040");
    expect(storedIds()).not.toContain("queue-001");
  });

  it("falls back to the default row limit for a broken maxRecords", () => {
    const { rowLimit } = repo.__test__;
    for (const bad of [0, -5, Number.NaN, "abc", undefined, null, Infinity]) expect(rowLimit(bad)).toBe(200);
    expect(rowLimit(7.9)).toBe(7);
    expect(rowLimit("12")).toBe(12);
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
      await fresh.saveRequestDetail(detail("fail-a", at(8, 0)));
      await fresh.saveRequestDetail(detail("fail-b", at(8, 1)));
      flushing = fresh.__test__.flush();
      // Two more saves wait behind it; the second cancels the timer the first armed.
      await fresh.saveRequestDetail(detail("left-c", at(8, 2), { messages: [] }));
      await fresh.saveRequestDetail(detail("left-d", at(8, 3), { messages: [] }));
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

  it("splits a backlog into writes of MAX_ROWS_PER_WRITE rows", async () => {
    await configure({ showSensitiveRequestDetails: false, observabilityMaxRecords: 1000 });
    const writes = vi.spyOn(adapter, "transaction");
    try {
      for (let i = 0; i < 450; i++) await db.saveRequestDetail(detail(`chunk-${pad(i, 3)}`, at(9, i), { messages: [] }));
      writes.mockClear();
      await repo.__test__.flush();
      expect(repo.__test__.MAX_ROWS_PER_WRITE).toBe(200);
      expect(writes).toHaveBeenCalledTimes(3);
    } finally {
      writes.mockRestore();
    }
    expect(storedIds()).toContain("chunk-449");
  });

  it("keeps no bodies while full details are off", async () => {
    await configure({ showSensitiveRequestDetails: false, observabilityMaxRecords: MAX_RECORDS, observabilityMaxJsonSize: 5 });
    const refs = await saveTracked(Array.from({ length: 30 }, (_, i) => `off-${pad(i)}`), (id) => at(10, Number(id.slice(4))));

    expect(await aliveAfterGc(refs)).toBe(0);
    expect(repo.__test__.buffered()).toBe(30);
    expect(repo.__test__.fullCandidates()).toBe(0);

    await repo.__test__.flush();
    expect((await db.getRequestDetailById("off-29")).request._truncated).toBe(true);
  });
});
