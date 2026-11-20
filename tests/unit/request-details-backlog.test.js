// Saves wait in memory until a flush writes them. A queued save holds only its
// capped record; full copies wait in a ring of at most 25 rows; and a write
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
  await configure(BASE_SETTINGS);
}, 60_000);

afterAll(async () => {
  await repo?.__test__.shutdown();
  vi.doUnmock("node:zlib");
  vi.unstubAllEnvs();
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

const BASE_SETTINGS = {
  enableObservability: true,
  showSensitiveRequestDetails: true,
  observabilityBatchSize: 1000,
  observabilityFlushIntervalMs: 10 * 60 * 1000,
  observabilityMaxRecords: MAX_RECORDS,
};

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
const ids = (count, prefix, width = 2) => Array.from({ length: count }, (_, i) => `${prefix}${pad(i, width)}`);
const idsWithFullData = () => adapter.all(`SELECT id FROM requestDetails WHERE fullData IS NOT NULL ORDER BY id`).map((r) => r.id);
const storedIds = () => adapter.all(`SELECT id FROM requestDetails ORDER BY id`).map((r) => r.id);
const lastNumber = (id) => Number(id.split("-").at(-1));

// Saves rows whose payloads only the repo could hold, and returns WeakRefs to
// them: each body object, its message list and first message, and the upstream
// request and reply. (A helper, so no caller's frame keeps the last one.)
async function saveTracked(rowIds, timestampOf) {
  const refs = [];
  for (const id of rowIds) {
    const request = bigRequest(id);
    const providerRequest = bigRequest(`${id}-upstream`);
    const providerResponse = { content: "y".repeat(150 * 1024) };
    // Small enough to be stored as it is, not cut.
    const response = { ok: true, id };
    refs.push(...[request, request.messages, request.messages[0], providerRequest, providerResponse, response].map((o) => new WeakRef(o)));
    await db.saveRequestDetail({ ...detail(id, timestampOf(id), request), providerRequest, providerResponse, response });
  }
  return refs;
}

// Saves a row whose only message is one flat string of `chars` characters.
async function saveHugeMessage(id, chars) {
  const content = JSON.parse(JSON.stringify("q".repeat(chars)));
  await db.saveRequestDetail(detail(id, at(7, 2000), { messages: [{ role: "user", content }] }));
}

async function heapAfterGc() {
  await new Promise((resolve) => setTimeout(resolve, 0));
  gc();
  gc();
  return process.memoryUsage().heapUsed;
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
  it("stores the same rows and the newest 25 rows' full copies, as before", async () => {
    for (let i = 0; i < 60; i++) await db.saveRequestDetail(detail(`row-${pad(i)}`, at(0, i)));
    await repo.__test__.flush();

    expect(storedIds()).toEqual(ids(60, "row-").slice(-MAX_RECORDS));
    expect(idsWithFullData()).toEqual(ids(60, "row-").slice(-25));
    expect((await db.getRequestDetailFullData("row-59")).request).toEqual(bigRequest("row-59"));
    const row = await db.getRequestDetailById("row-59");
    expect(row.request._truncated).toBe(true);
    expect(row.response).toEqual({ ok: true });
  });

  it("gzips exactly the newest 25 rows per write, whatever the backlog", async () => {
    for (let i = 0; i < 150; i++) await db.saveRequestDetail(detail(`many-${pad(i, 3)}`, at(1, i)));
    gzip.mockClear();
    await repo.__test__.flush();
    expect(gzip).toHaveBeenCalledTimes(25);
    expect(idsWithFullData()).toEqual(ids(150, "many-", 3).slice(-25));
  });

  it("holds only the ring's rows' cut payloads once a save returns, and none after the write", async () => {
    // Six refs per row (see saveTracked): the 15 rows pushed out of the ring hold nothing.
    const refs = await saveTracked(ids(40, "held-"), (id) => at(2, lastNumber(id)));
    expect(repo.__test__.ringSize()).toBe(25);
    expect(await aliveAfterGc(refs.slice(0, 15 * 6))).toBe(0);
    // The reply small enough to be stored as it is isn't held either.
    expect(await aliveAfterGc(refs.filter((_, i) => i % 6 === 5))).toBe(0);
    await repo.__test__.flush();
    expect(await aliveAfterGc(refs)).toBe(0);
    expect(idsWithFullData()).toContain("held-39");
  });

  it("serializes no body when it saves, and none whose copy was pushed out", async () => {
    const requests = Array.from({ length: 30 }, (_, i) => bigRequest(`lazy-${pad(i)}`));
    const providerRequests = requests.map((r, i) => bigRequest(`lazy-${pad(i)}-upstream`));
    const serialized = new Map();
    const real = JSON.stringify;
    const stringify = vi.spyOn(JSON, "stringify").mockImplementation(function (value, ...rest) {
      if (requests.includes(value) || providerRequests.includes(value)) serialized.set(value, (serialized.get(value) || 0) + 1);
      return real.call(JSON, value, ...rest);
    });
    try {
      for (let i = 0; i < 30; i++) {
        await db.saveRequestDetail({ ...detail(`lazy-${pad(i)}`, at(2, 100 + i), requests[i]), providerRequest: providerRequests[i] });
      }
      expect(serialized.size).toBe(0);
      await repo.__test__.flush();
    } finally {
      stringify.mockRestore();
    }
    // The newest 25 rows' payloads, once each, when the write packed them.
    for (let i = 0; i < 30; i++) {
      const expected = i < 5 ? undefined : 1;
      expect(serialized.get(requests[i])).toBe(expected);
      expect(serialized.get(providerRequests[i])).toBe(expected);
    }
    expect((await db.getRequestDetailFullData("lazy-29")).providerRequest).toEqual(providerRequests[29]);
  });

  it("serializes a stream's body once, when its end save is written", async () => {
    const request = bigRequest("reuse");
    const stringify = vi.spyOn(JSON, "stringify");
    let atSave;
    let atWrite;
    try {
      await db.saveRequestDetail(detail("reuse", at(2, 50), request));
      await db.saveRequestDetail({ ...detail("reuse", at(2, 51), request), status: "ok", tokens: { prompt_tokens: 3, completion_tokens: 2 } });
      atSave = stringify.mock.calls.filter(([value]) => value === request).length;
      await repo.__test__.flush();
      atWrite = stringify.mock.calls.filter(([value]) => value === request).length - atSave;
    } finally {
      stringify.mockRestore();
    }
    expect(atSave).toBe(0);
    expect(atWrite).toBe(1);
    expect((await db.getRequestDetailFullData("reuse")).request).toEqual(request);
  });

  it("keeps the ring within 25 rows and its byte cap", async () => {
    const { limits } = repo.__test__;
    const cap = limits.fullRingMaxBytes;
    try {
      await db.saveRequestDetail(detail("ring-00", at(3, 0)));
      const one = repo.__test__.ringBytes();
      limits.fullRingMaxBytes = MB;
      for (let i = 1; i < 10; i++) await db.saveRequestDetail(detail(`ring-${pad(i)}`, at(3, i)));
      const fit = Math.floor(MB / one);
      expect(repo.__test__.ringSize()).toBe(fit);
      expect(repo.__test__.ringBytes()).toBeLessThanOrEqual(MB);
      await repo.__test__.flush();
      expect(idsWithFullData().filter((id) => id.startsWith("ring-"))).toEqual(ids(10, "ring-").slice(-fit));
    } finally {
      limits.fullRingMaxBytes = cap;
    }
    for (let i = 0; i < 40; i++) await db.saveRequestDetail(detail(`ring-count-${pad(i)}`, at(3, 20 + i)));
    expect(repo.__test__.ringSize()).toBe(25);
    await repo.__test__.flush();
    expect(repo.__test__.ringSize()).toBe(0);
    expect(repo.__test__.ringBytes()).toBe(0);
  });

  it("keeps a row's stored copy when its end save's copy is pushed out for size", async () => {
    const { limits } = repo.__test__;
    const cap = limits.fullRingMaxBytes;
    const request = bigRequest("sized");
    await db.saveRequestDetail(detail("sized", at(3, 70), request));
    await repo.__test__.flush();
    expect((await db.getRequestDetailFullData("sized")).request).toEqual(request);
    try {
      // The end save (with a long reply) has a copy of its own, the oldest when
      // newer copies take the ring past its cap.
      const reply = { content: "z".repeat(150 * 1024) };
      await db.saveRequestDetail({ ...detail("sized", at(3, 71), request), providerResponse: reply, tokens: { prompt_tokens: 9, completion_tokens: 1 } });
      limits.fullRingMaxBytes = 2.5 * repo.__test__.ringBytes();
      for (let i = 0; i < 3; i++) await db.saveRequestDetail(detail(`sized-after-${i}`, at(3, 72 + i)));
      expect(repo.__test__.ringSize()).toBe(3);
      await repo.__test__.flush();
    } finally {
      limits.fullRingMaxBytes = cap;
    }
    const row = await db.getRequestDetailById("sized");
    expect(row.tokens).toEqual({ prompt_tokens: 9, completion_tokens: 1 });
    expect(row.hasFullData).toBe(true);
    // The start save's copy, not overwritten with none.
    expect(await db.getRequestDetailFullData("sized")).toEqual({ request });
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
    gzip.mockClear();
    try {
      await db.saveRequestDetail(detail("slow-000", at(5, 0)));
      flushing = repo.__test__.flush();
      await vi.waitFor(() => expect(gzip).toHaveBeenCalledTimes(1));
      for (let i = 1; i <= 200; i++) await db.saveRequestDetail(detail(`slow-${pad(i, 3)}`, at(5, i)));
      expect(repo.__test__.queued()).toBe(2 * MAX_RECORDS);
    } finally {
      release();
      await flushing?.catch(() => {});
    }
    // One held, then 25 for the next write: the newest 25 rows.
    expect(gzip).toHaveBeenCalledTimes(26);
    expect(idsWithFullData().filter((id) => id.startsWith("slow-"))).toEqual(ids(201, "slow-", 3).slice(-25));
    expect(repo.__test__.queued()).toBe(0);
    const kept = adapter.all(`SELECT id FROM requestDetails ORDER BY timestamp DESC`).map((r) => r.id);
    expect(kept).toHaveLength(MAX_RECORDS);
    expect(kept[0]).toBe("slow-200");
    expect(kept[MAX_RECORDS - 1]).toBe("slow-161");
  });

  it("caps the queue by bytes, a running write's included, dropping the oldest saves", async () => {
    const { limits } = repo.__test__;
    const cap = limits.queuedRecordsMaxBytes;
    const release = holdGzip();
    let flushing;
    let limit;
    try {
      await db.saveRequestDetail(detail("bytes-000", at(6, 0)));
      gzip.mockClear();
      flushing = repo.__test__.flush();
      await vi.waitFor(() => expect(gzip).toHaveBeenCalledTimes(1));
      const inFlight = repo.__test__.inFlightBytes();
      expect(inFlight).toBeGreaterThan(0);
      // Room for the running write and five more records of the same size.
      limit = 6 * inFlight;
      limits.queuedRecordsMaxBytes = limit;
      for (let i = 1; i <= 30; i++) await db.saveRequestDetail(detail(`bytes-${pad(i, 3)}`, at(6, i)));
      expect(repo.__test__.queued()).toBe(5);
      // The dropped saves took their waiting copies with them.
      expect(repo.__test__.ringSize()).toBe(5);
      expect(repo.__test__.queuedBytes() + repo.__test__.inFlightBytes()).toBeLessThanOrEqual(limit);
    } finally {
      release();
      await flushing?.catch(() => {});
      limits.queuedRecordsMaxBytes = cap;
    }
    expect(storedIds()).toEqual(expect.arrayContaining(["bytes-026", "bytes-030"]));
    expect(storedIds()).not.toContain("bytes-025");
  });

  it.each([-1, "abc", 0.5])("uses the default row limit for maxRecords %j", async (maxRecords) => {
    const release = holdGzip();
    let flushing;
    try {
      await configure({ observabilityMaxRecords: maxRecords });
      await db.saveRequestDetail(detail("limit-000", at(7, 0)));
      gzip.mockClear();
      flushing = repo.__test__.flush();
      await vi.waitFor(() => expect(gzip).toHaveBeenCalled());
      for (let i = 1; i <= 410; i++) await db.saveRequestDetail(detail(`limit-${pad(i, 3)}`, at(7, i), { messages: [] }));
      // Twice the 200 fallback, and the trim keeps 200.
      expect(repo.__test__.queued()).toBe(400);
      release();
      await flushing;
      expect(adapter.get(`SELECT COUNT(*) AS c FROM requestDetails`).c).toBe(200);
      expect(storedIds()).toContain("limit-410");
    } finally {
      release();
      await flushing?.catch(() => {});
      await configure(BASE_SETTINGS);
    }
  });

  it("writes a backlog in transactions of at most 200 rows", async () => {
    const writes = vi.spyOn(adapter, "transaction");
    try {
      // A row cap high enough that none of the 450 saves is dropped.
      await configure({ observabilityMaxRecords: 300 });
      for (let i = 0; i < 450; i++) await db.saveRequestDetail(detail(`split-${pad(i, 3)}`, at(7, 600 + i), { messages: [] }));
      writes.mockClear();
      await repo.__test__.flush();
      expect(writes).toHaveBeenCalledTimes(3);
      expect(storedIds()).toContain("split-449");
    } finally {
      writes.mockRestore();
      await configure(BASE_SETTINGS);
    }
  });

  it("holds a waiting copy's message once, not again as JSON or in its preview", async () => {
    // A save whose message is one 12 MB string (under the 16 MB copy limit): its
    // copy waits in the ring, which holds the message itself; neither its JSON
    // nor a slice of it in the capped preview may be held as well.
    const CHARS = 12 * MB;
    const before = await heapAfterGc();
    await saveHugeMessage("huge-message", CHARS);
    expect(repo.__test__.ringSize()).toBeGreaterThan(0);
    // The message (one byte a char here), not twice.
    expect((await heapAfterGc()) - before).toBeLessThan(CHARS * 1.5);
    await repo.__test__.flush();
    expect((await db.getRequestDetailFullData("huge-message")).request.messages[0].content).toHaveLength(CHARS);
  });

  it("builds no full copy for a save made after shutdown", async () => {
    vi.resetModules();
    const fresh = await import("@/lib/db/repos/requestDetailsRepo.js");
    try {
      await fresh.__test__.shutdown();
      await fresh.saveRequestDetail(detail("after-shutdown", at(7, 2100)));
      expect(fresh.__test__.queued()).toBe(1);
      expect(fresh.__test__.ringSize()).toBe(0);
      await fresh.__test__.flush();
      expect((await db.getRequestDetailById("after-shutdown")).hasFullData).toBe(false);
    } finally {
      await fresh.__test__.flush();
    }
  });

  it("holds no payload while full details are off", async () => {
    try {
      await configure({ showSensitiveRequestDetails: false });
      const refs = await saveTracked(ids(30, "off-"), (id) => at(8, lastNumber(id)));
      expect(await aliveAfterGc(refs)).toBe(0);
      expect(repo.__test__.ringSize()).toBe(0);
      expect(repo.__test__.queued()).toBe(30);
      await repo.__test__.flush();
      expect((await db.getRequestDetailById("off-29")).request._truncated).toBe(true);
      expect(await db.getRequestDetailFullData("off-29")).toBeNull();
    } finally {
      await configure(BASE_SETTINGS);
    }
  });

  it("clears the ring when full details are turned off", async () => {
    try {
      for (let i = 0; i < 5; i++) await db.saveRequestDetail(detail(`toggle-${i}`, at(9, i)));
      expect(repo.__test__.ringSize()).toBe(5);
      await configure({ showSensitiveRequestDetails: false });
      expect(repo.__test__.ringSize()).toBe(0);
      expect(repo.__test__.ringBytes()).toBe(0);
      await repo.__test__.flush();
      expect(await db.getRequestDetailFullData("toggle-4")).toBeNull();
    } finally {
      await configure(BASE_SETTINGS);
    }
  });

  it("writes the saves left behind a failed write without another save", async () => {
    vi.resetModules();
    const fresh = await import("@/lib/db/repos/requestDetailsRepo.js");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const release = holdGzip();
    let failOnce;
    let flushing;
    try {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      await db.updateSettings({ observabilityBatchSize: 2 });
      await fresh.clearRequestDetailFullData();
      failOnce = vi.spyOn(adapter, "transaction").mockImplementationOnce(() => { throw new Error("disk full"); });
      // The second save reaches the batch size and starts a write, held while it compresses.
      await fresh.saveRequestDetail(detail("fail-a", at(10, 0)));
      await fresh.saveRequestDetail(detail("fail-b", at(10, 1)));
      flushing = fresh.__test__.flush();
      // Two more saves wait behind it; the second cancels the timer the first armed.
      await fresh.saveRequestDetail(detail("left-c", at(10, 2), { messages: [] }));
      await fresh.saveRequestDetail(detail("left-d", at(10, 3), { messages: [] }));
      release();
      await flushing;
      expect(consoleError).toHaveBeenCalledWith("[requestDetailsRepo] Batch write failed:", expect.any(Error));
      expect(fresh.__test__.inFlightBytes()).toBe(0);
      expect(storedIds()).not.toContain("left-c");

      // Only the re-armed timer can write them now.
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
      await vi.waitFor(() => expect(storedIds()).toEqual(expect.arrayContaining(["left-c", "left-d"])), { timeout: 5000 });
    } finally {
      release();
      await flushing?.catch(() => {});
      failOnce?.mockRestore();
      consoleError.mockRestore();
      vi.useRealTimers();
      await fresh.__test__.shutdown();
      await configure(BASE_SETTINGS);
    }
  });
});
