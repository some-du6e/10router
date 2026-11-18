// Saves wait in memory until a flush writes them. A flush must keep up with the
// requests feeding it, and whatever the backlog, only a few saves may hold on
// to their request's whole body.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import v8 from "node:v8";
import vm from "node:vm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

v8.setFlagsFromString("--expose-gc");
const gc = vm.runInNewContext("gc");

const MAX_RECORDS = 40;
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
  await db.updateSettings({
    enableObservability: true,
    showSensitiveRequestDetails: true,
    observabilityBatchSize: 1000,
    observabilityFlushIntervalMs: 10 * 60 * 1000,
    observabilityMaxRecords: MAX_RECORDS,
  });
  adapter = await (await import("@/lib/db/driver.js")).getAdapter();
}, 60_000);

afterAll(async () => {
  await repo?.__test__.shutdown();
  vi.doUnmock("node:zlib");
  vi.unstubAllEnvs();
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

// Over the 128 KB cap, so every save is cut and has a full copy to pack.
const bigRequest = (tag) => ({ messages: [{ role: "user", content: `${tag}:` + "x".repeat(200 * 1024) }] });
const detail = (id, timestamp, request = bigRequest(id)) => ({ id, timestamp, provider: "openai", model: "gpt-4", status: "ok", request, response: { ok: true } });
const at = (month, second) => new Date(Date.UTC(2026, month, 1, 0, 0, second)).toISOString();
const pad = (n, width = 2) => String(n).padStart(width, "0");
const idsWithFullData = () => adapter.all(`SELECT id FROM requestDetails WHERE fullData IS NOT NULL ORDER BY id`).map((r) => r.id);
// The row each gzip call packed, read from the tag its request body starts with.
const gzippedIds = () => gzip.mock.calls.map(([input]) => JSON.parse(String(input)).request.messages[0].content.split(":")[0]);

// Saves rows whose bodies only the repo can hold, and returns WeakRefs to them.
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

describe("request detail backlog", { timeout: 60_000 }, () => {
  it("runs on a driver that stores full copies", () => {
    expect(adapter.driver).not.toBe("sql.js");
  });

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
    await db.saveRequestDetail(detail("stream", at(1, 59), stream));
    await repo.__test__.flush();

    const packed = gzippedIds();
    expect(packed).toHaveLength(25);
    expect(packed.filter((id) => id === "stream")).toHaveLength(1);
    expect([...packed].sort()).toEqual(idsWithFullData());
    expect(idsWithFullData()).toContain("tie-b");
    expect(idsWithFullData()).not.toContain("tie-a");
  });

  it("caps the saves waiting behind a slow flush", async () => {
    const release = holdGzip();
    try {
      await db.saveRequestDetail(detail("slow-000", at(2, 0)));
      const flushing = repo.__test__.flush();
      for (let i = 1; i <= 200; i++) await db.saveRequestDetail(detail(`slow-${pad(i, 3)}`, at(2, i)));
      expect(repo.__test__.buffered()).toBe(2 * MAX_RECORDS);
      release();
      await flushing;
    } finally {
      release();
    }
    expect(repo.__test__.buffered()).toBe(0);
    const ids = adapter.all(`SELECT id FROM requestDetails ORDER BY timestamp DESC`).map((r) => r.id);
    expect(ids).toHaveLength(MAX_RECORDS);
    expect(ids[0]).toBe("slow-200");
    expect(ids[MAX_RECORDS - 1]).toBe("slow-161");
  });

  it("lets go of the bodies of saves that can't get a full copy, in the queue and in a stuck flush", async () => {
    const { MAX_FULL_CANDIDATES } = repo.__test__;
    const release = holdGzip();
    let refs = [];
    try {
      // A flush takes 120 saves and gets stuck compressing the first it packs.
      refs = await saveTracked(Array.from({ length: 120 }, (_, i) => `held-${pad(i, 3)}`), (id) => at(3, Number(id.slice(5))));
      const flushing = repo.__test__.flush();
      // More saves arrive behind it.
      refs.push(...await saveTracked(Array.from({ length: 70 }, (_, i) => `late-${pad(i, 3)}`), (id) => at(4, Number(id.slice(5)))));

      expect(repo.__test__.fullCandidates()).toBe(MAX_FULL_CANDIDATES);
      // The bodies kept: the newest MAX_FULL_CANDIDATES saves, plus the one being compressed.
      expect(await aliveAfterGc(refs)).toBeLessThanOrEqual(MAX_FULL_CANDIDATES + 1);
      expect(refs[0].deref()).toBeUndefined();
      expect(refs.at(-1).deref()).toBeDefined();

      release();
      await flushing;
    } finally {
      release();
    }
    expect(repo.__test__.fullCandidates()).toBe(0);
    expect(await aliveAfterGc(refs)).toBe(0);
  });

  it("keeps no bodies while full details are off", async () => {
    await db.updateSettings({ showSensitiveRequestDetails: false });
    await db.clearRequestDetailFullData();
    const refs = await saveTracked(Array.from({ length: 30 }, (_, i) => `off-${pad(i)}`), (id) => at(5, Number(id.slice(4))));

    expect(repo.__test__.buffered()).toBe(30);
    expect(repo.__test__.fullCandidates()).toBe(0);
    expect(await aliveAfterGc(refs)).toBe(0);

    await repo.__test__.flush();
    expect((await db.getRequestDetailById("off-29")).request._truncated).toBe(true);
  });
});
