// Saves wait in memory until a flush writes them. A flush must keep up with the
// requests feeding it, and whatever the backlog, only a few saves may hold the
// JSON of a whole body, within a byte budget, and none may hold the body itself.
import { randomBytes } from "node:crypto";
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
// Which gate a gzip call waits on, by its input.
let gateFor = () => gate;

beforeAll(async () => {
  vi.stubEnv("ENABLE_REQUEST_LOGS", "true");
  vi.stubEnv("OBSERVABILITY_MAX_JSON_SIZE", "");
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "10router-backlog-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  vi.doMock("node:zlib", async (importOriginal) => {
    const zlib = await importOriginal();
    gzip.mockImplementation((input, callback) => { gateFor(String(input)).then(() => zlib.gzip(input, callback)); });
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
// Hard to compress, so a packed copy is about as big as its JSON.
const noisy = (tag, chars = 200 * 1024) => ({ messages: [{ role: "user", content: `${tag}:${randomBytes(Math.ceil((chars * 3) / 4)).toString("base64")}` }] });
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
  // Node keeps big strings (a packed copy's base64) outside the V8 heap.
  const { heapUsed, external } = process.memoryUsage();
  return heapUsed + external;
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
    let serializedAgain;
    try {
      await db.saveRequestDetail(detail("stream", at(1, 59), stream));
      await repo.__test__.flush();
      serializedAgain = stringify.mock.calls.filter(([value]) => value === stream).length;
    } finally {
      stringify.mockRestore();
    }

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
    // A row cap high enough that no save is dropped (120 in the running write,
    // 70 queued): only the JSON window limits them.
    await configure({ observabilityMaxRecords: 200 });
    const BODY = MB;
    gzip.mockClear();
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
      expect(grown).toBeLessThan((max + 1) * BODY * 1.5 + 8 * MB);

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

  it("doesn't keep an earlier save's packed copy alive once its stream is gone", async () => {
    // Each stream's start save is packed while its end save waits; then the
    // streams end (their bodies go). The end saves hold only their own JSON.
    const ROWS = 25;
    const BODY = MB;
    gzip.mockClear();
    const before = await heapAfterGc();
    // Start saves' copies wait on one gate, end saves' (which have a reply) on another.
    let openStarts;
    let openEnds;
    const starts = new Promise((resolve) => { openStarts = resolve; });
    const ends = new Promise((resolve) => { openEnds = resolve; });
    gateFor = (input) => (input.includes('"providerResponse"') ? ends : starts);
    const release = () => { openStarts(); openEnds(); gateFor = () => gate; };
    let flushing;
    try {
      let bodies = Array.from({ length: ROWS }, (_, i) => noisy(`pin-${pad(i)}`, BODY));
      for (let i = 0; i < ROWS; i++) await db.saveRequestDetail(detail(`pin-${pad(i)}`, at(4, 30 + i), bodies[i]));
      flushing = repo.__test__.flush();
      await vi.waitFor(() => expect(gzip).toHaveBeenCalledTimes(1));
      // The end saves also cut a reply, so their copy isn't the start save's.
      const reply = { content: "r".repeat(20 * 1024) };
      for (let i = 0; i < ROWS; i++) await db.saveRequestDetail({ ...detail(`pin-${pad(i)}`, at(4, 90 + i), bodies[i]), providerResponse: reply });
      // Let the start saves' write finish; the end saves' write is held.
      openStarts();
      await vi.waitFor(() => expect(gzip).toHaveBeenCalledTimes(ROWS + 1), { timeout: 60_000, interval: 50 });
      bodies = null;
      gzip.mockClear();

      const held = repo.__test__.fullCandidateBytes?.() ?? 0;
      expect(held).toBeGreaterThan(0);
      // The end saves' JSON (one byte a char here, half the estimate) and the
      // one being compressed; not the 25 packed start copies as well.
      // A window holding its capped objects strongly also keeps those copies
      // (about held / 2 more) and fails this.
      expect((await heapAfterGc()) - before).toBeLessThan((held / 2) * 1.2 + BODY * 2 + 8 * MB);
    } finally {
      release();
      await flushing?.catch(() => {});
    }
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

  it("counts each held string once: a stream's shared JSON, and an earlier save's packed copy", async () => {
    const request = bigRequest("acct");
    const json = JSON.stringify(request);
    await db.saveRequestDetail(detail("acct", at(6, 0), request));
    expect(repo.__test__.fullCandidateBytes()).toBe(2 * json.length);
    // The end save of the same stream holds the same JSON.
    await db.saveRequestDetail(detail("acct", at(6, 1), request));
    expect(repo.__test__.fullCandidates()).toBe(2);
    expect(repo.__test__.fullCandidateBytes()).toBe(2 * json.length);
    await repo.__test__.flush();
    expect(repo.__test__.fullCandidateBytes()).toBe(0);

    // Its start save already written and packed, an end save holds that packed copy.
    const next = bigRequest("acct-next");
    await db.saveRequestDetail(detail("acct-next", at(6, 2), next));
    await repo.__test__.flush();
    const { fullData } = adapter.get(`SELECT fullData FROM requestDetails WHERE id = ?`, ["acct-next"]);
    gzip.mockClear();
    await db.saveRequestDetail(detail("acct-next", at(6, 3), next));
    expect(repo.__test__.fullCandidateBytes()).toBe(2 * fullData.length);
    await repo.__test__.flush();
    expect(gzip).not.toHaveBeenCalled();
    expect(repo.__test__.fullCandidateBytes()).toBe(0);
  });

  it("clears the stored full copy when the end save is over the full copy limit", async () => {
    // Over 16M characters, and under that but over 16 MB as UTF-8.
    for (const [id, huge] of [["end-chars", "x".repeat(17 * MB)], ["end-utf8", "€".repeat(6 * MB)]]) {
      const request = bigRequest(id);
      await db.saveRequestDetail(detail(id, at(6, 10), request));
      await repo.__test__.flush();
      expect((await db.getRequestDetailFullData(id)).request).toEqual(request);

      await db.saveRequestDetail({ ...detail(id, at(6, 11), request), providerResponse: { content: huge } });
      expect(repo.__test__.fullCandidates()).toBe(0);
      await repo.__test__.flush();
      expect((await db.getRequestDetailById(id)).providerResponse._truncated).toBe(true);
      expect(await db.getRequestDetailFullData(id)).toBeNull();
    }
  });

  it("cuts queued records down past their byte budget, a running write's counted, and keeps every save", async () => {
    // A stream's start save is written first.
    const stream = bigRequest("deg-stream");
    const streaming = (timestamp, response, tokens) => ({ ...detail("deg-stream", timestamp, stream), response, providerResponse: response, tokens });
    await db.saveRequestDetail(streaming(at(7, 0), { content: "[Streaming in progress...]", type: "streaming" }, { prompt_tokens: 0, completion_tokens: 0 }));
    await repo.__test__.flush();

    const { limits } = repo.__test__;
    const budget = limits.queuedRecordsMaxBytes;
    const release = holdGzip();
    let flushing;
    let limit = 0;
    try {
      // A write of 6 saves (over 100 KB of records), held while it compresses.
      for (let i = 0; i < 6; i++) await db.saveRequestDetail(detail(`deg-held-${i}`, at(7, 1 + i)));
      gzip.mockClear();
      flushing = repo.__test__.flush();
      await vi.waitFor(() => expect(gzip).toHaveBeenCalledTimes(1));
      const inFlight = repo.__test__.inFlightBytes();
      expect(inFlight).toBeGreaterThan(100 * 1024);
      limit = inFlight + 200 * 1024;
      limits.queuedRecordsMaxBytes = limit;

      // The stream ends, then 30 more saves: all far over what's left of the budget.
      await db.saveRequestDetail(streaming(at(7, 10), { content: "all done", type: "streaming" }, { prompt_tokens: 10, completion_tokens: 5 }));
      for (let i = 0; i < 30; i++) {
        // One carries a long string payload, which is cut down too.
        const save = detail(`deg-${pad(i)}`, at(7, 20 + i));
        await db.saveRequestDetail(i === 1 ? { ...save, providerResponse: "z".repeat(10_000) } : save);
      }

      expect(repo.__test__.buffered()).toBe(31);
      expect(repo.__test__.queuedBytes() + repo.__test__.inFlightBytes()).toBeLessThanOrEqual(limit);
    } finally {
      release();
      await flushing?.catch(() => {});
      limits.queuedRecordsMaxBytes = budget;
    }
    const row = await db.getRequestDetailById("deg-stream");
    expect(row.status).toBe("ok");
    expect(row.tokens).toEqual({ prompt_tokens: 10, completion_tokens: 5 });
    expect(row.response.content).toBe("all done");
    expect(row.request._truncated).toBe(true);
    expect(storedIds()).toEqual(expect.arrayContaining(["deg-00", "deg-29"]));
    // A cut-down row offers no full copy; the newest, untouched ones still do.
    expect((await db.getRequestDetailById("deg-00")).hasFullData).toBe(false);
    expect((await db.getRequestDetailById("deg-29")).hasFullData).toBe(true);
    const stringRow = await db.getRequestDetailById("deg-01");
    expect(stringRow.providerResponse._truncated).toBe(true);
    expect(stringRow.providerResponse._preview).toBe("z".repeat(1024));
  });

  it("caps the queue at what fits its byte budget cut down, then drops the oldest cut-down saves", async () => {
    const { limits } = repo.__test__;
    const budget = limits.queuedRecordsMaxBytes;
    const release = holdGzip();
    let flushing;
    let limit = 0;
    try {
      for (let i = 0; i < 6; i++) await db.saveRequestDetail(detail(`cap-held-${i}`, at(7, 40 + i)));
      gzip.mockClear();
      flushing = repo.__test__.flush();
      await vi.waitFor(() => expect(gzip).toHaveBeenCalledTimes(1));
      // Room for 15 cut-down records by count, but only 30 KB of bytes left.
      limit = repo.__test__.inFlightBytes() + 30 * 1024;
      limits.queuedRecordsMaxBytes = limit;
      const maxQueued = Math.floor(limit / (10 * 1024));
      for (let i = 0; i < 40; i++) await db.saveRequestDetail(detail(`cap-${pad(i)}`, at(7, 60 + i)));

      expect(repo.__test__.buffered()).toBeLessThanOrEqual(maxQueued);
      expect(repo.__test__.buffered()).toBeGreaterThan(0);
      expect(repo.__test__.queuedBytes() + repo.__test__.inFlightBytes()).toBeLessThanOrEqual(limit);
    } finally {
      release();
      await flushing?.catch(() => {});
      limits.queuedRecordsMaxBytes = budget;
    }
    expect(storedIds()).toContain("cap-39");
    expect(storedIds()).not.toContain("cap-00");
  });

  it("packs a body sent to several keys once, and holds its JSON once", async () => {
    // Ten failover attempts: equal bodies, separate objects.
    const json = JSON.stringify(bigRequest("failover"));
    for (let i = 0; i < 10; i++) await db.saveRequestDetail(detail(`failover-${i}`, at(7, 120 + i), bigRequest("failover")));
    expect(repo.__test__.fullCandidates()).toBe(10);
    expect(repo.__test__.fullCandidateBytes()).toBe(2 * json.length);
    gzip.mockClear();
    await repo.__test__.flush();
    expect(gzip).toHaveBeenCalledTimes(1);
    for (const id of ["failover-0", "failover-9"]) expect((await db.getRequestDetailFullData(id)).request).toEqual(bigRequest("failover"));
  });

  it("stops packing a write's older rows at the budget, and never takes the newest saves' slots for it", async () => {
    const { limits } = repo.__test__;
    const budget = limits.fullCandidatesMaxBytes;
    limits.fullCandidatesMaxBytes = MB;
    let release = holdGzip();
    let flushing;
    try {
      // Two saves fit the window (about 400 KB of JSON each).
      await db.saveRequestDetail(detail("mid-old", at(7, 140), noisy("mid-old")));
      await db.saveRequestDetail(detail("mid-new", at(7, 141), noisy("mid-new")));
      gzip.mockClear();
      flushing = repo.__test__.flush();
      await vi.waitFor(() => expect(gzip).toHaveBeenCalledTimes(1));
      // Two newer saves arrive while the write compresses its newest row.
      await db.saveRequestDetail(detail("after-0", at(7, 142), noisy("after-0")));
      await db.saveRequestDetail(detail("after-1", at(7, 143), noisy("after-1")));
      // Let that write finish, and hold the next one, which takes the two newer saves.
      release();
      release = holdGzip();
      await vi.waitFor(() => expect(gzip).toHaveBeenCalledTimes(2));
      // The first write's copy took it past the budget: its older row got none,
      // and the newer saves kept their slots.
      expect(repo.__test__.fullCandidates()).toBe(2);
      expect(await db.getRequestDetailFullData("mid-old")).toBeNull();
      expect(await db.getRequestDetailFullData("mid-new")).not.toBeNull();
      release();
      await flushing;
      // The second write packed its newest row, and that copy filled the budget.
      expect(gzip).toHaveBeenCalledTimes(2);
      expect(await db.getRequestDetailFullData("after-1")).not.toBeNull();
      expect(await db.getRequestDetailFullData("after-0")).toBeNull();
    } finally {
      release();
      await flushing?.catch(() => {});
      limits.fullCandidatesMaxBytes = budget;
    }
  });

  it("splits a backlog into writes of at most writeMaxBytes", async () => {
    await configure({ showSensitiveRequestDetails: false, observabilityMaxRecords: 1000 });
    const { limits } = repo.__test__;
    const max = limits.writeMaxBytes;
    const writes = vi.spyOn(adapter, "transaction");
    try {
      // Nine records of one size, three to a write.
      await db.saveRequestDetail(detail("bytes-0", at(8, 10), { messages: [] }));
      limits.writeMaxBytes = 3 * repo.__test__.queuedBytes();
      for (let i = 1; i < 9; i++) await db.saveRequestDetail(detail(`bytes-${i}`, at(8, 10 + i), { messages: [] }));
      writes.mockClear();
      await repo.__test__.flush();
      expect(writes).toHaveBeenCalledTimes(3);
    } finally {
      writes.mockRestore();
      limits.writeMaxBytes = max;
    }
    expect(storedIds()).toContain("bytes-8");
  });

  it("lets queued saves' full-copy JSON go when full details are turned off", async () => {
    await configure({ showSensitiveRequestDetails: true, observabilityMaxRecords: 200 });
    for (let i = 0; i < 5; i++) await db.saveRequestDetail(detail(`toggle-${i}`, at(8, 30 + i)));
    expect(repo.__test__.fullCandidates()).toBe(5);
    expect(repo.__test__.fullCandidateBytes()).toBeGreaterThan(0);

    await configure({ showSensitiveRequestDetails: false });
    expect(repo.__test__.fullCandidates()).toBe(0);
    expect(repo.__test__.fullCandidateBytes()).toBe(0);
    await repo.__test__.flush();
    expect(await db.getRequestDetailFullData("toggle-4")).toBeNull();
    await configure({ showSensitiveRequestDetails: true });
  });

  it("uses the default row limit for the queue cap and the trim when maxRecords is broken", async () => {
    vi.stubEnv("OBSERVABILITY_MAX_RECORDS", "abc");
    await configure({ observabilityMaxRecords: 0 });
    const release = holdGzip();
    let flushing;
    try {
      await db.saveRequestDetail(detail("limit-000", at(11, 0)));
      gzip.mockClear();
      flushing = repo.__test__.flush();
      await vi.waitFor(() => expect(gzip).toHaveBeenCalled());
      for (let i = 1; i <= 450; i++) await db.saveRequestDetail(detail(`limit-${pad(i, 3)}`, at(11, i), { messages: [] }));
      // Twice the 200 fallback, not the settings default of 1000.
      expect(repo.__test__.buffered()).toBe(400);
    } finally {
      release();
      await flushing?.catch(() => {});
      vi.stubEnv("OBSERVABILITY_MAX_RECORDS", "");
    }
    expect(adapter.get(`SELECT COUNT(*) AS c FROM requestDetails`).c).toBe(200);
    expect(storedIds()).toContain("limit-450");
    await configure({ observabilityMaxRecords: 200 });
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
      await fresh.saveRequestDetail(detail("fail-a", at(12, 0)));
      await fresh.saveRequestDetail(detail("fail-b", at(12, 1)));
      flushing = fresh.__test__.flush();
      // Two more saves wait behind it; the second cancels the timer the first armed.
      await fresh.saveRequestDetail(detail("left-c", at(12, 2), { messages: [] }));
      await fresh.saveRequestDetail(detail("left-d", at(12, 3), { messages: [] }));
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
      for (let i = 0; i < 450; i++) await db.saveRequestDetail(detail(`chunk-${pad(i, 3)}`, at(13, i), { messages: [] }));
      writes.mockClear();
      await repo.__test__.flush();
      expect(writes).toHaveBeenCalledTimes(3);
      expect(repo.__test__.MAX_ROWS_PER_WRITE).toBe(200);
    } finally {
      writes.mockRestore();
    }
    expect(storedIds()).toContain("chunk-449");
  });

  it("keeps no bodies while full details are off", async () => {
    await configure({ showSensitiveRequestDetails: false, observabilityMaxRecords: MAX_RECORDS, observabilityMaxJsonSize: 5 });
    const refs = await saveTracked(Array.from({ length: 30 }, (_, i) => `off-${pad(i)}`), (id) => at(14, Number(id.slice(4))));

    expect(await aliveAfterGc(refs)).toBe(0);
    expect(repo.__test__.buffered()).toBe(30);
    expect(repo.__test__.fullCandidates()).toBe(0);

    await repo.__test__.flush();
    expect((await db.getRequestDetailById("off-29")).request._truncated).toBe(true);
  });
});
