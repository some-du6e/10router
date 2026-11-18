// Rows wait in memory, holding their request's whole body, until a flush
// writes them. A flush must keep up with the requests feeding it, and the rows
// waiting behind a slow one must stay bounded.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const MAX_RECORDS = 40;
const originalDataDir = process.env.DATA_DIR;
let tempDir;
let db;
let repo;
let adapter;
const gzip = vi.fn();
let gate = Promise.resolve();

beforeAll(async () => {
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
    observabilityMaxRecords: MAX_RECORDS,
  });
  adapter = await (await import("@/lib/db/driver.js")).getAdapter();
});

afterAll(() => {
  vi.doUnmock("node:zlib");
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

// Over the 128 KB cap, so every row is cut and has a full copy to pack.
const bigRequest = (tag) => ({ messages: [{ role: "user", content: `${tag}:` + "x".repeat(200 * 1024) }] });
const detail = (id, timestamp) => ({ id, timestamp, provider: "openai", model: "gpt-4", status: "ok", request: bigRequest(id), response: { ok: true } });
const at = (month, second) => new Date(Date.UTC(2026, month, 1, 0, 0, second)).toISOString();
const idsWithFullData = () => adapter.all(`SELECT id FROM requestDetails WHERE fullData IS NOT NULL ORDER BY id`).map((r) => r.id);

describe("request detail backlog", () => {
  it("packs full copies only for the rows the table keeps them on", async () => {
    for (let i = 0; i < 60; i++) await db.saveRequestDetail(detail(`row-${String(i).padStart(2, "0")}`, at(0, i)));
    gzip.mockClear();
    await repo.__test__.flush();

    expect(gzip).toHaveBeenCalledTimes(25);
    const newest = Array.from({ length: 25 }, (_, i) => `row-${35 + i}`);
    expect(idsWithFullData()).toEqual(newest);
    expect((await db.getRequestDetailFullData("row-59")).request).toEqual(bigRequest("row-59"));
    expect(await db.getRequestDetailFullData("row-34")).toBeNull();
  });

  it("picks those rows the way the trim orders them", () => {
    const { idsKeepingFullData } = repo.__test__;
    const items = Array.from({ length: 30 }, (_, i) => ({ id: `r${String(i).padStart(2, "0")}`, timestamp: at(1, i) }));
    // A stream's end save comes last and newest, under the id its start save had.
    items.push({ id: "r00", timestamp: at(1, 59) });
    // Same timestamp: the higher id goes first.
    items.push({ id: "tie-a", timestamp: at(1, 6) }, { id: "tie-b", timestamp: at(1, 6) });

    const kept = idsKeepingFullData(items);
    expect(kept.size).toBe(25);
    expect(kept.has("r00")).toBe(true);
    expect(kept.has("r29")).toBe(true);
    expect(kept.has("r07")).toBe(true);
    expect(kept.has("tie-b")).toBe(true);
    expect(kept.has("tie-a")).toBe(false);
    expect(kept.has("r06")).toBe(false);
  });

  it("bounds the rows waiting behind a slow flush", async () => {
    let release;
    gate = new Promise((resolve) => { release = resolve; });
    await db.saveRequestDetail(detail("slow-000", at(2, 0)));
    const flushing = repo.__test__.flush();
    for (let i = 1; i <= 200; i++) await db.saveRequestDetail(detail(`slow-${String(i).padStart(3, "0")}`, at(2, i)));

    expect(repo.__test__.buffered()).toBe(2 * MAX_RECORDS);

    release();
    await flushing;
    expect(repo.__test__.buffered()).toBe(0);
    const ids = adapter.all(`SELECT id FROM requestDetails ORDER BY timestamp DESC`).map((r) => r.id);
    expect(ids).toHaveLength(MAX_RECORDS);
    expect(ids[0]).toBe("slow-200");
    expect(ids[MAX_RECORDS - 1]).toBe("slow-161");
  });
});
