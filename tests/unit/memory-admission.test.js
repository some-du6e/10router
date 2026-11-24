// Memory admission (src/sse/services/memoryAdmission.js): a burst of big
// requests waits for room, then is refused with a retryable 503, instead of
// taking the process past its memory limit.
import { describe, it, expect, vi } from "vitest";
import {
  createMemoryGate,
  withMemoryAdmission,
  carryAdmission,
  releaseWhenDone,
  busyResponse,
  readCgroupMemoryLimit,
  resolveHighWater,
  heapFitWarning,
  idleWhile,
} from "@/sse/services/memoryAdmission.js";
import { FORMATS } from "open-sse/translator/formats.js";

const MB = 1024 * 1024;
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const quietLog = () => ({ info: vi.fn(), warn: vi.fn() });

function gate(overrides = {}) {
  return createMemoryGate({
    budgetBytes: 100 * MB,
    highWaterBytes: 0,
    bodyCopies: 1,
    pendingHeapCopies: 1,
    pendingRssCopies: 1,
    maxWaitMs: 1000,
    retryAfterSec: 7,
    recheckMs: 5,
    rss: () => 0,
    heapHighWaterPct: 0,
    heapStats: () => ({ used_heap_size: 0, heap_size_limit: 0 }),
    logger: quietLog(),
    ...overrides,
  });
}

// A gate with only the heap check: 85% of a 1000 MB heap is 850 MB.
function heapGate(heap, overrides = {}) {
  return gate({
    budgetBytes: 0,
    heapHighWaterPct: 85,
    heapStats: () => ({ used_heap_size: heap.used, heap_size_limit: 1000 * MB }),
    ...overrides,
  });
}

function request(path, { bytes = 0, signal } = {}) {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(bytes ? { "content-length": String(bytes) } : {}) },
    body: "{}",
    signal,
  });
}

// A streaming reply the test ends, fails or leaves open.
function openStream() {
  let controller;
  const body = new ReadableStream({ start(c) { controller = c; } });
  const response = new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  return { response, controller };
}

describe("gate", () => {
  it("admits requests while they fit the budget", async () => {
    const g = gate();
    const a = await g.acquire({ bodyLength: 40 * MB });
    const b = await g.acquire({ bodyLength: 40 * MB });
    expect(a.ticket && b.ticket).toBeTruthy();
    expect(g.stats()).toMatchObject({ inflight: 2, heldBytes: 80 * MB, waiting: 0 });
    a.ticket.release();
    a.ticket.release(); // idempotent
    expect(g.stats()).toMatchObject({ inflight: 1, heldBytes: 40 * MB });
  });

  it("counts bodyCopies copies of each body", async () => {
    const g = gate({ bodyCopies: 3 });
    const { ticket } = await g.acquire({ bodyLength: 10 * MB });
    expect(ticket.bytes).toBe(30 * MB);
    // The body turned out longer than Content-Length said; never shrinks.
    ticket.noteBodyLength(20 * MB);
    ticket.noteBodyLength(1);
    expect(g.stats().heldBytes).toBe(60 * MB);
  });

  it("queues a request that doesn't fit and admits it when room frees, first come first served", async () => {
    const g = gate();
    const held = await g.acquire({ bodyLength: 90 * MB });
    const order = [];
    const big = g.acquire({ bodyLength: 50 * MB }).then((r) => { order.push("big"); return r; });
    const small = g.acquire({ bodyLength: 1 * MB }).then((r) => { order.push("small"); return r; });
    await tick();
    // The small one would fit, but it arrived behind the big one.
    expect(order).toEqual([]);
    expect(g.stats().waiting).toBe(2);
    held.ticket.release();
    const [b, s] = await Promise.all([big, small]);
    expect(b.ticket && s.ticket).toBeTruthy();
    expect(order).toEqual(["big", "small"]);
    expect(g.stats()).toMatchObject({ inflight: 2, waiting: 0, queued: 2 });
  });

  it("refuses a request still without room after maxWaitMs", async () => {
    const logger = quietLog();
    const g = gate({ maxWaitMs: 20, logger });
    await g.acquire({ bodyLength: 90 * MB });
    const result = await g.acquire({ bodyLength: 50 * MB });
    expect(result).toEqual({ refused: "budget", retryAfterSec: 7 });
    expect(g.stats()).toMatchObject({ refused: 1, waiting: 0, refusing: true });
  });

  it("admits a request bigger than the whole budget when nothing else is in flight", async () => {
    const g = gate({ maxWaitMs: 20 });
    const huge = await g.acquire({ bodyLength: 500 * MB });
    expect(huge.ticket).toBeTruthy();
    // ...but not next to another one.
    expect((await g.acquire({ bodyLength: 1 * MB })).refused).toBe("budget");
    huge.ticket.release();
    expect((await g.acquire({ bodyLength: 1 * MB })).ticket).toBeTruthy();
  });

  it("drops a waiter whose client hangs up, and lets the one behind it move up", async () => {
    const g = gate();
    const held = await g.acquire({ bodyLength: 90 * MB });
    const abort = new AbortController();
    const first = g.acquire({ bodyLength: 50 * MB, signal: abort.signal });
    const second = g.acquire({ bodyLength: 5 * MB });
    await tick();
    abort.abort();
    expect(await first).toEqual({ aborted: true });
    expect((await second).ticket).toBeTruthy();
    expect(g.stats()).toMatchObject({ inflight: 2, waiting: 0, aborted: 1 });
    held.ticket.release();
  });

  it("logs once when it starts refusing and once when it admits again", async () => {
    const logger = quietLog();
    const g = gate({ maxWaitMs: 5, logger });
    const held = await g.acquire({ bodyLength: 90 * MB });
    await g.acquire({ bodyLength: 50 * MB });
    await g.acquire({ bodyLength: 50 * MB });
    await g.acquire({ bodyLength: 50 * MB });
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][1]).toMatch(/refusing new requests \(budget\)/);
    held.ticket.release();
    await g.acquire({ bodyLength: 50 * MB });
    await g.acquire({ bodyLength: 1 * MB });
    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.info.mock.calls[0][1]).toMatch(/admitting requests again after refusing 3/);
  });
});

describe("resident-memory backstop", () => {
  it("holds new requests while rss is over the high-water mark, and lets them in when it drops", async () => {
    let rss = 1700 * MB;
    const g = gate({ budgetBytes: 0, highWaterBytes: 1600 * MB, rss: () => rss });
    const first = await g.acquire({ bodyLength: 1 * MB });
    // Nothing else in flight: in, whatever rss says.
    expect(first.ticket).toBeTruthy();
    const waiting = g.acquire({ bodyLength: 1 * MB });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(g.stats().waiting).toBe(1);
    // Garbage collection brings rss down with no request ending.
    rss = 1200 * MB;
    expect((await waiting).ticket).toBeTruthy();
    expect(g.stats()).toMatchObject({ inflight: 2, waiting: 0 });
  });

  it("refuses when rss stays high for the whole wait", async () => {
    const g = gate({ budgetBytes: 0, highWaterBytes: 1600 * MB, rss: () => 1900 * MB, maxWaitMs: 20 });
    await g.acquire({ bodyLength: 1 * MB });
    expect(await g.acquire({ bodyLength: 1 * MB })).toEqual({ refused: "memory", retryAfterSec: 7 });
  });

  it("is off when no limit is set", () => {
    expect(gate({ budgetBytes: 0, highWaterBytes: 0 }).enabled).toBe(false);
    expect(gate({ budgetBytes: 0, highWaterBytes: 0, heapHighWaterPct: 85 }).enabled).toBe(true);
  });

  it("reads the container limit from cgroup v2, then v1, and ignores 'max'", () => {
    const files = (map) => (path) => {
      if (path in map) return map[path];
      throw new Error("ENOENT");
    };
    expect(readCgroupMemoryLimit(files({ "/sys/fs/cgroup/memory.max": "2147483648\n" }))).toBe(2 * 1024 * MB);
    expect(readCgroupMemoryLimit(files({ "/sys/fs/cgroup/memory.max": "max\n" }))).toBe(null);
    expect(readCgroupMemoryLimit(files({ "/sys/fs/cgroup/memory/memory.limit_in_bytes": "1073741824" }))).toBe(1024 * MB);
    expect(readCgroupMemoryLimit(files({ "/sys/fs/cgroup/memory/memory.limit_in_bytes": "9223372036854771712" }))).toBe(null);
    expect(readCgroupMemoryLimit(files({}))).toBe(null);
  });

  it("warns when the V8 heap limit leaves the container too little room", () => {
    // V8's default in a 2 GiB container: fine.
    expect(heapFitWarning({ heapLimit: 1048 * MB, containerLimit: 2048 * MB })).toBe(null);
    // --max-old-space-size=1400 in 2 GiB: the kernel killed it before V8 collected.
    expect(heapFitWarning({ heapLimit: 1400 * MB, containerLimit: 2048 * MB })).toMatch(/V8 heap limit \(1400MB\) is over 60% of the container's memory \(2048MB\).*--max-old-space-size to 1228 or less/);
    expect(heapFitWarning({ heapLimit: 1400 * MB, containerLimit: null })).toBe(null);
  });

  it("puts the high-water mark at a fraction of the limit unless MEMORY_HIGH_WATER_MB is set", () => {
    expect(resolveHighWater({ highWaterMb: -1, fraction: 0.8, limit: () => 2000 * MB })).toBe(1600 * MB);
    expect(resolveHighWater({ highWaterMb: -1, fraction: 0.8, limit: () => null })).toBe(0);
    expect(resolveHighWater({ highWaterMb: 1200, fraction: 0.8, limit: () => 2000 * MB })).toBe(1200 * MB);
    expect(resolveHighWater({ highWaterMb: 0, fraction: 0.8, limit: () => 2000 * MB })).toBe(0);
  });
});

// V8 aborts the process when its heap fills ("JavaScript heap out of memory"),
// long before resident memory reaches the container's limit.
describe("heap backstop", () => {
  it("holds new requests while the heap is over its high-water mark, and lets them in when it drops", async () => {
    const heap = { used: 900 * MB };
    const g = heapGate(heap);
    // Nothing else in flight: in, whatever the heap says.
    expect((await g.acquire({ bodyLength: 1 * MB })).ticket).toBeTruthy();
    const waiting = g.acquire({ bodyLength: 1 * MB });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(g.stats().waiting).toBe(1);
    // Garbage collection brings the heap down with no request ending: in at
    // the next recheck, well before its wait (1 s) runs out.
    heap.used = 500 * MB;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(g.stats().waiting).toBe(0);
    expect((await waiting).ticket).toBeTruthy();
    expect(g.stats()).toMatchObject({ inflight: 2, waiting: 0 });
  });

  it("refuses with reason heap when the heap stays high for the whole wait, and logs it", async () => {
    const logger = quietLog();
    const g = heapGate({ used: 900 * MB }, { maxWaitMs: 20, logger });
    await g.acquire({ bodyLength: 1 * MB });
    expect(await g.acquire({ bodyLength: 1 * MB })).toEqual({ refused: "heap", retryAfterSec: 7 });
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][0]).toBe("MEMORY");
    expect(logger.warn.mock.calls[0][1]).toMatch(/refusing new requests \(heap\): 1 in flight holding 1MB, 1MB of bodies not yet replying, heap 900MB \+ 2MB coming \(high water 850MB of 1000MB\), 1 waiting/);
  });

  it("counts admitted requests that haven't started replying, which the heap doesn't show yet", async () => {
    // A burst all arrives before any of it has been parsed: the heap still reads 100 MB.
    const g = heapGate({ used: 100 * MB }, { maxWaitMs: 1000 });
    const a = await g.acquire({ bodyLength: 300 * MB });
    const b = await g.acquire({ bodyLength: 300 * MB });
    expect(a.ticket && b.ticket).toBeTruthy();
    expect(g.stats().pendingBytes).toBe(600 * MB);
    // 100 + 600 + 300 > 850.
    const c = g.acquire({ bodyLength: 300 * MB });
    await tick();
    expect(g.stats().waiting).toBe(1);
    // a's reply started: what it still holds is in the heap reading from now on.
    a.ticket.replied();
    a.ticket.replied(); // idempotent
    // At once, not at the next recheck.
    expect(g.stats().waiting).toBe(0);
    expect((await c).ticket).toBeTruthy();
    expect(g.stats()).toMatchObject({ inflight: 3, pendingBytes: 600 * MB, heldBytes: 900 * MB });
    b.ticket.release();
    expect(g.stats()).toMatchObject({ inflight: 2, pendingBytes: 300 * MB, heldBytes: 600 * MB });
    // A ticket released after its reply started doesn't count twice.
    a.ticket.release();
    expect(g.stats()).toMatchObject({ inflight: 1, pendingBytes: 300 * MB, heldBytes: 300 * MB });
  });

  it("counts the new request's own body copies against the heap", async () => {
    const g = heapGate({ used: 700 * MB }, { pendingHeapCopies: 3, maxWaitMs: 20 });
    const first = await g.acquire({ bodyLength: 10 * MB });
    first.ticket.replied();
    // 700 + 3 × 60 > 850, though the heap alone is under it.
    expect((await g.acquire({ bodyLength: 60 * MB })).refused).toBe("heap");
    expect((await g.acquire({ bodyLength: 40 * MB })).ticket).toBeTruthy();
  });

  it("keeps a request answered early counted until its routing settles (pendUntil)", async () => {
    const g = heapGate({ used: 100 * MB }, { maxWaitMs: 1000 });
    const a = await g.acquire({ bodyLength: 300 * MB });
    let finishRouting;
    a.ticket.pendUntil(new Promise((resolve) => { finishRouting = resolve; }));
    let failRouting;
    a.ticket.pendUntil(new Promise((_, reject) => { failRouting = reject; }));
    // Early headers: the reply has started, routing (fallbacks) hasn't ended.
    a.ticket.replied();
    expect(g.stats().pendingBytes).toBe(300 * MB);
    // 100 + 300 + 500 > 850.
    const b = g.acquire({ bodyLength: 500 * MB });
    finishRouting();
    await tick();
    expect(g.stats()).toMatchObject({ pendingBytes: 300 * MB, waiting: 1 });
    // A failed route ends it too.
    failRouting(new Error("upstream failed"));
    await tick();
    expect(g.stats().pendingBytes).toBe(500 * MB);
    expect((await b).ticket).toBeTruthy();
  });

  it("routing that settles before the reply starts leaves it pending until replied()", async () => {
    const g = heapGate({ used: 0 });
    const { ticket } = await g.acquire({ bodyLength: 10 * MB });
    ticket.pendUntil(Promise.resolve());
    await tick();
    expect(g.stats().pendingBytes).toBe(10 * MB);
    ticket.replied();
    expect(g.stats().pendingBytes).toBe(0);
    // Released while routing is still out: nothing left counted, nothing goes negative later.
    const other = await g.acquire({ bodyLength: 10 * MB });
    let finish;
    other.ticket.pendUntil(new Promise((resolve) => { finish = resolve; }));
    other.ticket.release();
    finish();
    await tick();
    expect(g.stats()).toMatchObject({ inflight: 1, pendingBytes: 0, heldBytes: 10 * MB });
  });

  it("projects the bytes still coming onto resident memory too", async () => {
    const g = gate({ budgetBytes: 0, highWaterBytes: 1600 * MB, rss: () => 1000 * MB, pendingRssCopies: 5, maxWaitMs: 20 });
    const first = await g.acquire({ bodyLength: 60 * MB });
    // 1000 + 5 × 60 + 5 × 60 = 1600: fits exactly.
    expect((await g.acquire({ bodyLength: 60 * MB })).ticket).toBeTruthy();
    // 1000 + 600 + 5 × 1 > 1600, though rss alone is far under it.
    expect((await g.acquire({ bodyLength: 1 * MB })).refused).toBe("memory");
    first.ticket.replied();
    expect((await g.acquire({ bodyLength: 1 * MB })).ticket).toBeTruthy();
  });

  it("stops counting a request while it sleeps (idleWhile); awake, it waits for room ahead of new requests", async () => {
    const g = heapGate({ used: 100 * MB }, { maxWaitMs: 5000 });
    let wake;
    let during;
    let newcomer;
    const res = await withMemoryAdmission(request("/v1/messages", { bytes: 300 * MB }), async () => {
      // Deep in routing, with no ticket at hand: found through the request's async context.
      const sleeping = idleWhile(new Promise((resolve) => { wake = resolve; }));
      during = g.stats().pendingBytes;
      // Another request fits in the room it gave back: 100 + 500 ≤ 850.
      const other = await g.acquire({ bodyLength: 500 * MB });
      wake("ok");
      await tick();
      // Awake, it doesn't take the room back: 100 + 500 + 300 > 850.
      expect(g.stats()).toMatchObject({ waiting: 1, resumeWaits: 1, pendingBytes: 500 * MB });
      // A new request arriving now queues behind it.
      newcomer = g.acquire({ bodyLength: 500 * MB });
      await tick();
      expect(g.stats().waiting).toBe(2);
      other.ticket.release();
      // It goes first, and is counted at once, so the new one (100 + 300 + 500 > 850) still waits.
      expect(g.stats()).toMatchObject({ waiting: 1, pendingBytes: 300 * MB });
      expect(await sleeping).toBe("ok");
      return new Response("done");
    }, { gate: g });
    await res.text();
    // Its reply started: the new one fits now.
    expect((await newcomer).ticket).toBeTruthy();
    expect(during).toBe(0);
    // Outside any admitted request it does nothing.
    await expect(idleWhile(Promise.resolve(1))).resolves.toBe(1);
  });

  it("an awake request goes on with nothing else in flight, after the wait at most, or when released", async () => {
    // Alone: in at once, whatever the heap says.
    const heap = { used: 900 * MB };
    const alone = heapGate(heap, { maxWaitMs: 5000 });
    await withMemoryAdmission(request("/v1/messages", { bytes: 10 * MB }), async () => {
      await idleWhile(Promise.resolve());
      expect(alone.stats()).toMatchObject({ resumeWaits: 0, pendingBytes: 10 * MB });
      return new Response(null, { status: 204 });
    }, { gate: alone });

    // Not alone and no room: it waits maxWaitMs, then goes on anyway (it was admitted).
    const rising = { used: 100 * MB };
    const busy = heapGate(rising, { maxWaitMs: 30 });
    const other = await busy.acquire({ bodyLength: 1 * MB });
    await withMemoryAdmission(request("/v1/messages", { bytes: 10 * MB }), async () => {
      rising.used = 900 * MB;
      const t0 = Date.now();
      // A failed sleep is passed on, after the wait for room.
      await expect(idleWhile(Promise.reject(new Error("aborted")))).rejects.toThrow("aborted");
      expect(Date.now() - t0).toBeGreaterThanOrEqual(25);
      expect(busy.stats()).toMatchObject({ resumeWaits: 1, waiting: 0, pendingBytes: 11 * MB });
      return new Response(null, { status: 204 });
    }, { gate: busy });
    other.ticket.release();

    // Released while it waits for room: it leaves the queue, and the queue moves.
    const later = { used: 100 * MB };
    const g = heapGate(later, { maxWaitMs: 5000 });
    const held = await g.acquire({ bodyLength: 1 * MB });
    let ticket;
    const resuming = withMemoryAdmission(request("/v1/messages", { bytes: 10 * MB }), async (t) => {
      ticket = t;
      later.used = 900 * MB;
      await idleWhile(Promise.resolve());
      return new Response(null, { status: 204 });
    }, { gate: g });
    await tick();
    expect(g.stats().waiting).toBe(1);
    ticket.release();
    expect(g.stats()).toMatchObject({ waiting: 0, pendingBytes: 1 * MB });
    await resuming;
    held.ticket.release();
    expect(g.stats()).toMatchObject({ inflight: 0, pendingBytes: 0, heldBytes: 0 });
  });

  it("checks nothing when MEMORY_HEAP_HIGH_WATER_PCT is 0", async () => {
    const heapStats = vi.fn(() => ({ used_heap_size: 990 * MB, heap_size_limit: 1000 * MB }));
    const g = heapGate({}, { heapHighWaterPct: 0, budgetBytes: 100 * MB, heapStats });
    await g.acquire({ bodyLength: 1 * MB });
    expect((await g.acquire({ bodyLength: 1 * MB })).ticket).toBeTruthy();
    expect(heapStats).not.toHaveBeenCalled();
  });

  it("reads the real heap by default", async () => {
    const g = createMemoryGate({ budgetBytes: 0, highWaterBytes: 0, heapHighWaterPct: 85, logger: quietLog() });
    expect(g.enabled).toBe(true);
    await g.acquire({ bodyLength: 1 });
    expect((await g.acquire({ bodyLength: 1 })).ticket).toBeTruthy();
  });
});

describe("a body without Content-Length", () => {
  it("counts as unknownBodyBytes until it is read, then as its real length", async () => {
    const g = gate({ budgetBytes: 200 * MB, bodyCopies: 3, unknownBodyBytes: 20 * MB });
    const held = await g.acquire({ bodyLength: 40 * MB });
    const { ticket } = await g.acquire({ bodyLength: null });
    expect(ticket.bytes).toBe(60 * MB);
    // Waits: 120 + 60 + 30 > 200.
    const next = g.acquire({ bodyLength: 10 * MB });
    await tick();
    expect(g.stats().waiting).toBe(1);
    // The body was short: the guess gives way, which lets the next one in.
    ticket.noteBodyLength(1 * MB);
    expect(ticket.bytes).toBe(3 * MB);
    // At once, not when its wait runs out.
    expect(g.stats()).toMatchObject({ waiting: 0, inflight: 3 });
    expect((await next).ticket).toBeTruthy();
    // From then on it only grows, like a stated length.
    ticket.noteBodyLength(1);
    expect(ticket.bytes).toBe(3 * MB);
    // pendingBytes counts the bodies themselves.
    expect(g.stats()).toMatchObject({ heldBytes: (120 + 3 + 30) * MB, pendingBytes: (40 + 1 + 10) * MB });
    held.ticket.release();
  });

  it("is admitted through withMemoryAdmission at the guess, and counted as not yet replying until its reply starts", async () => {
    const g = gate({ budgetBytes: 1000 * MB, bodyCopies: 3, unknownBodyBytes: 4 * MB });
    const { response, controller } = openStream();
    const chunked = new Request("http://localhost/v1/messages", { method: "POST", body: "{}", headers: { "content-type": "application/json" } });
    expect(chunked.headers.get("content-length")).toBeNull();
    let during;
    const res = await withMemoryAdmission(chunked, async (ticket) => {
      during = { bytes: ticket.bytes, ...g.stats() };
      return response;
    }, { gate: g });
    expect(during).toMatchObject({ bytes: 12 * MB, pendingBytes: 4 * MB });
    // Replying: still held until the reply ends, no longer pending.
    expect(g.stats()).toMatchObject({ inflight: 1, heldBytes: 12 * MB, pendingBytes: 0 });
    const reading = res.text();
    controller.close();
    await reading;
    expect(g.stats()).toMatchObject({ inflight: 0, heldBytes: 0, pendingBytes: 0 });
  });

  it("a guessed body that waited in the queue still gives way to its real length", async () => {
    const g = gate({ budgetBytes: 100 * MB, unknownBodyBytes: 60 * MB });
    const held = await g.acquire({ bodyLength: 50 * MB });
    const waiting = g.acquire({ bodyLength: null });
    await tick();
    held.ticket.release();
    const { ticket } = await waiting;
    expect(ticket.bytes).toBe(60 * MB);
    ticket.noteBodyLength(2 * MB);
    expect(g.stats()).toMatchObject({ heldBytes: 2 * MB, pendingBytes: 2 * MB });
  });

  it.each([["abc"], [" "], ["-5"]])("a Content-Length of %j counts as no length", async (value) => {
    const g = gate({ unknownBodyBytes: 20 * MB });
    const req = new Request("http://localhost/v1/messages", { method: "POST", headers: { "content-length": value } });
    await withMemoryAdmission(req, async (ticket) => {
      expect(ticket.bytes).toBe(20 * MB);
      return new Response(null, { status: 204 });
    }, { gate: g });
  });

  it("an empty stated body counts as 0, not the guess", async () => {
    const g = gate({ unknownBodyBytes: 20 * MB });
    const res = await withMemoryAdmission(request("/v1/messages"), async (ticket) => {
      expect(ticket.bytes).toBe(20 * MB);
      return new Response("ok");
    }, { gate: g });
    await res.text();
    const empty = new Request("http://localhost/v1/messages", { method: "POST", headers: { "content-length": "0" } });
    await withMemoryAdmission(empty, async (ticket) => {
      expect(ticket.bytes).toBe(0);
      return new Response(null, { status: 204 });
    }, { gate: g });
  });
});

describe("withMemoryAdmission", () => {
  it("runs an admitted request and holds its room until the stream ends", async () => {
    const g = gate();
    const { response, controller } = openStream();
    const res = await withMemoryAdmission(request("/v1/chat/completions", { bytes: 30 * MB }), async (ticket) => {
      expect(ticket.bytes).toBe(30 * MB);
      return response;
    }, { gate: g });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(g.stats()).toMatchObject({ inflight: 1, heldBytes: 30 * MB });
    const reading = res.text();
    controller.enqueue(new TextEncoder().encode("data: hi\n\n"));
    await tick();
    expect(g.stats().inflight).toBe(1);
    controller.close();
    expect(await reading).toBe("data: hi\n\n");
    expect(g.stats()).toMatchObject({ inflight: 0, heldBytes: 0 });
  });

  it("releases when the client hangs up mid-stream", async () => {
    const g = gate();
    const abort = new AbortController();
    const { response } = openStream();
    await withMemoryAdmission(request("/v1/messages", { bytes: 10 * MB, signal: abort.signal }), async () => response, { gate: g });
    expect(g.stats().inflight).toBe(1);
    abort.abort();
    expect(g.stats().inflight).toBe(0);
  });

  it("releases when the reply is cancelled", async () => {
    const g = gate();
    const { response } = openStream();
    const res = await withMemoryAdmission(request("/v1/messages", { bytes: 10 * MB }), async () => response, { gate: g });
    await res.body.cancel();
    expect(g.stats().inflight).toBe(0);
  });

  it("releases when the stream fails", async () => {
    const g = gate();
    const { response, controller } = openStream();
    const res = await withMemoryAdmission(request("/v1/responses", { bytes: 10 * MB }), async () => response, { gate: g });
    const reading = res.text();
    controller.error(new Error("upstream reset"));
    await expect(reading).rejects.toThrow("upstream reset");
    expect(g.stats().inflight).toBe(0);
  });

  it("releases when the handler throws", async () => {
    const g = gate();
    await expect(withMemoryAdmission(request("/v1/messages", { bytes: 10 * MB }), async () => {
      throw new Error("boom");
    }, { gate: g })).rejects.toThrow("boom");
    expect(g.stats().inflight).toBe(0);
  });

  it("releases at once for a reply without a body", async () => {
    const g = gate();
    const res = await withMemoryAdmission(request("/v1/messages", { bytes: 10 * MB }), async () => new Response(null, { status: 204 }), { gate: g });
    expect(res.status).toBe(204);
    expect(g.stats().inflight).toBe(0);
  });

  it.each([
    ["/v1/messages", (body) => expect(body).toEqual({ type: "error", error: { type: "overloaded_error", message: expect.stringContaining("retry in 7s") } })],
    ["/v1/chat/completions", (body) => expect(body.error).toMatchObject({ type: "server_error", code: "service_unavailable", message: expect.stringContaining("retry in 7s") })],
    ["/v1/responses", (body) => expect(body.error).toMatchObject({ type: "server_error", code: "service_unavailable" })],
    ["/api/v1/codex/responses", (body) => expect(body.error).toMatchObject({ code: "service_unavailable" })],
  ])("refuses %s after the wait with a 503, Retry-After and the client's error shape, without running it", async (path, check) => {
    const g = gate({ maxWaitMs: 10 });
    const held = await g.acquire({ bodyLength: 90 * MB });
    const run = vi.fn();
    const res = await withMemoryAdmission(request(path, { bytes: 50 * MB }), run, { gate: g });
    expect(run).not.toHaveBeenCalled();
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("7");
    check(await res.json());
    held.ticket.release();
  });

  it("answers 499 when the client hangs up while waiting", async () => {
    const g = gate();
    const held = await g.acquire({ bodyLength: 90 * MB });
    const abort = new AbortController();
    const run = vi.fn();
    const pending = withMemoryAdmission(request("/v1/messages", { bytes: 50 * MB, signal: abort.signal }), run, { gate: g });
    await tick();
    abort.abort();
    expect((await pending).status).toBe(499);
    expect(run).not.toHaveBeenCalled();
    held.ticket.release();
    expect(g.stats()).toMatchObject({ inflight: 0, waiting: 0 });
  });

  it("admits a request a route rewrote once, under the route's admission", async () => {
    const g = gate();
    const outer = request("/api/v1/codex/responses", { bytes: 10 * MB });
    const res = await withMemoryAdmission(outer, async (ticket) => {
      const inner = carryAdmission(outer, request("/v1/responses"));
      return withMemoryAdmission(inner, async (innerTicket) => {
        expect(innerTicket).toBe(ticket);
        expect(g.stats().inflight).toBe(1);
        return new Response("ok");
      }, { gate: g });
    }, { gate: g });
    expect(await res.text()).toBe("ok");
    expect(g.stats().inflight).toBe(0);
  });

  it("passes requests straight through when the gate is off", async () => {
    const g = gate({ budgetBytes: 0, highWaterBytes: 0 });
    const original = new Response("ok");
    const res = await withMemoryAdmission(request("/v1/messages", { bytes: 10 * MB }), async (ticket) => {
      expect(ticket).toBe(null);
      return original;
    }, { gate: g });
    expect(res).toBe(original);
  });
});

describe("helpers", () => {
  it("releaseWhenDone keeps status and headers", async () => {
    const release = vi.fn();
    const res = releaseWhenDone(new Response("x", { status: 201, headers: { "x-a": "1" } }), { release, bytes: 0, noteBodyLength() {} });
    expect(res.status).toBe(201);
    expect(res.headers.get("x-a")).toBe("1");
    expect(await res.text()).toBe("x");
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("busyResponse speaks Claude to Claude clients", async () => {
    const res = busyResponse(FORMATS.CLAUDE, 3);
    expect(res.headers.get("retry-after")).toBe("3");
    expect((await res.json()).type).toBe("error");
  });
});

// handleChat itself goes through the shared gate: admitted, then released once
// its reply is read.
vi.mock("@/lib/localDb", () => ({ getSettings: async () => ({ requireApiKey: true }) }));
const { handleChat } = await import("@/sse/handlers/chat.js");
const { memoryAdmissionStats } = await import("@/sse/services/memoryAdmission.js");

describe("handleChat wiring", () => {
  it("admits a chat request through the shared gate and releases it when the reply ends", async () => {
    const before = memoryAdmissionStats().admitted;
    const body = JSON.stringify({ model: "openai/gpt-x", messages: [{ role: "user", content: "hi" }] });
    const res = await handleChat(new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": String(body.length) },
      body,
    }));
    // No API key while one is required: refused by routing, after admission.
    expect(res.status).toBe(401);
    expect(memoryAdmissionStats()).toMatchObject({ admitted: before + 1, inflight: 1 });
    await res.text();
    expect(memoryAdmissionStats().inflight).toBe(0);
  });

  // With no content-length the gate admits the request at a guessed length, so
  // only the body read under the ticket can count its real one. Reading it
  // before admission, or without passing the ticket, leaves the guess.
  it("reads a body without content-length only once admitted, and counts it while the reply is open", async () => {
    const before = memoryAdmissionStats();
    const text = JSON.stringify({ model: "openai/gpt-x", messages: [{ role: "user", content: "x".repeat(4096) }] });
    let admittedAtFirstRead = null;
    const stream = new ReadableStream({
      pull(controller) {
        admittedAtFirstRead ??= memoryAdmissionStats().admitted;
        controller.enqueue(new TextEncoder().encode(text));
        controller.close();
      },
    }, { highWaterMark: 0 });
    const request = new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: stream,
      duplex: "half",
    });
    expect(request.headers.get("content-length")).toBeNull();

    const res = await handleChat(request);
    // No API key while one is required: refused after the body is read.
    expect(res.status).toBe(401);
    expect(admittedAtFirstRead).toBe(before.admitted + 1);
    const held = memoryAdmissionStats();
    expect(held.inflight).toBe(before.inflight + 1);
    expect(held.heldBytes - before.heldBytes).toBe(3 * text.length);

    await res.text();
    expect(memoryAdmissionStats()).toMatchObject({ inflight: before.inflight, heldBytes: before.heldBytes });
  });
});
