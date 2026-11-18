import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const usage = vi.hoisted(() => ({ stats: vi.fn(), active: vi.fn() }));
vi.mock("@/lib/usageDb", async () => {
  const { EventEmitter } = await import("node:events");
  return { getUsageStats: usage.stats, getActiveRequests: usage.active, statsEmitter: new EventEmitter() };
});

import { statsEmitter } from "@/lib/usageDb";
import { GET } from "../../src/app/api/usage/stream/route.js";

const LIVE = { activeRequests: [], recentRequests: [], errorProvider: "", pending: { byModel: {}, byAccount: {} } };
const live = (count) => ({ ...LIVE, activeRequests: [{ model: "model-a", provider: "provider-a", account: "Account A", count }] });
const decoder = new TextDecoder();
// Lets queued promise continuations run when the assertion is that nothing happens.
const afterPendingWork = () => new Promise((resolve) => setImmediate(resolve));

let response;
let reader;

beforeEach(() => {
  // Only the keepalive interval is faked, so its timer count is observable.
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  vi.resetAllMocks();
  statsEmitter.removeAllListeners();
  usage.active.mockResolvedValue(LIVE);
  response = null;
  reader = null;
});

afterEach(async () => {
  if (reader) await reader.cancel().catch(() => {});
  else await response?.body?.cancel().catch(() => {});
  statsEmitter.removeAllListeners();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function open(controller = new AbortController()) {
  response = GET(new Request("http://localhost/api/usage/stream", { signal: controller.signal }));
  return controller;
}

async function connect(controller) {
  const c = open(controller);
  response = await response;
  reader = response.body.getReader();
  await vi.waitFor(() => expect(statsEmitter.listenerCount("pending")).toBe(1));
  return c;
}

async function readFrame() {
  const { value, done } = await reader.read();
  expect(done).toBe(false);
  return decoder.decode(value);
}

const readJson = async () => JSON.parse((await readFrame()).replace(/^data: /, ""));

function expectCleanedUp() {
  expect(statsEmitter.listenerCount("update")).toBe(0);
  expect(statsEmitter.listenerCount("pending")).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
}

describe("usage stream lifecycle", () => {
  it("sends live fields on connect and on update and pending events", async () => {
    const controller = await connect();
    expect(await readJson()).toEqual(LIVE);

    usage.active.mockResolvedValueOnce(live(1));
    statsEmitter.emit("pending");
    expect((await readJson()).activeRequests[0].count).toBe(1);

    usage.active.mockResolvedValueOnce(live(2));
    statsEmitter.emit("update");
    expect((await readJson()).activeRequests[0].count).toBe(2);

    controller.abort();
    expectCleanedUp();
    expect((await reader.read()).done).toBe(true);
  });

  it("never sends full stats or API keys", async () => {
    const rawKey = "sk-placeholder-raw-key";
    usage.stats.mockResolvedValue({ totalRequests: 5, byApiKey: { [`${rawKey}|model-a|provider-a`]: { requests: 5 } } });
    usage.active.mockResolvedValue({ ...LIVE, byApiKey: { [`${rawKey}|model-a|provider-a`]: {} }, apiKey: rawKey });
    await connect();

    const frame = await readFrame();
    expect(frame).not.toContain("byApiKey");
    expect(frame).not.toContain(rawKey);
    expect(Object.keys(JSON.parse(frame.replace(/^data: /, ""))).sort()).toEqual(["activeRequests", "errorProvider", "pending", "recentRequests"]);
    statsEmitter.emit("update");
    expect(await readFrame()).not.toContain(rawKey);
    expect(usage.stats).not.toHaveBeenCalled();
  });

  it("keeps only the newest frame for a client that stops reading", async () => {
    const controller = await connect();
    for (const count of [1, 2, 3]) {
      usage.active.mockResolvedValueOnce(live(count));
      statsEmitter.emit("pending");
    }
    await vi.waitFor(() => expect(usage.active).toHaveBeenCalledTimes(4));
    await afterPendingWork();

    expect(await readJson()).toEqual(LIVE);
    expect((await readJson()).activeRequests[0].count).toBe(3);
    controller.abort();
    expect((await reader.read()).done).toBe(true);
  });

  it("skips pings for a client that stops reading", async () => {
    const controller = await connect();
    usage.active.mockResolvedValueOnce(live(1));
    statsEmitter.emit("pending");
    await vi.waitFor(() => expect(usage.active).toHaveBeenCalledTimes(2));
    await afterPendingWork();
    vi.advanceTimersByTime(25000);

    expect(await readJson()).toEqual(LIVE);
    expect((await readJson()).activeRequests[0].count).toBe(1);
    controller.abort();
    expect((await reader.read()).done).toBe(true);
  });

  it("pings every 25 seconds while connected", async () => {
    await connect();
    await readFrame();
    vi.advanceTimersByTime(25000);
    expect(await readFrame()).toBe(": ping\n\n");
  });

  it("cleans up when a keepalive write throws", async () => {
    await connect();
    await readFrame();
    vi.spyOn(ReadableStreamDefaultController.prototype, "enqueue").mockImplementationOnce(() => {
      throw new TypeError("Invalid state");
    });
    vi.advanceTimersByTime(25000);
    expectCleanedUp();
    expect((await reader.read()).done).toBe(true);
  });

  it.each(["update", "pending"])("cleans up when the live read fails on %s", async (event) => {
    await connect();
    await readFrame();
    usage.active.mockRejectedValueOnce(new Error("DB unavailable"));
    statsEmitter.emit(event);
    expect((await reader.read()).done).toBe(true);
    expectCleanedUp();
  });

  it("cleans listeners and keepalive immediately on request abort", async () => {
    const controller = await connect();
    expect(vi.getTimerCount()).toBe(1);
    controller.abort();
    expectCleanedUp();
  });

  it("does not subscribe after an initial read failure", async () => {
    usage.active.mockRejectedValueOnce(new Error("DB unavailable"));
    open();
    response = await response;
    reader = response.body.getReader();
    expect((await reader.read()).done).toBe(true);
    expectCleanedUp();
  });

  it("does not subscribe or enqueue after abort during the initial read", async () => {
    let resolveLive;
    usage.active.mockReturnValueOnce(new Promise((resolve) => { resolveLive = resolve; }));
    const controller = open();
    response = await response;
    reader = response.body.getReader();
    await vi.waitFor(() => expect(usage.active).toHaveBeenCalledTimes(1));
    const enqueue = vi.spyOn(ReadableStreamDefaultController.prototype, "enqueue");

    controller.abort();
    resolveLive(LIVE);
    await afterPendingWork();

    expect(enqueue).not.toHaveBeenCalled();
    expectCleanedUp();
    expect((await reader.read()).done).toBe(true);
  });

  it("does not start work for an already aborted request", async () => {
    const controller = new AbortController();
    controller.abort();
    open(controller);
    response = await response;
    expect(usage.active).not.toHaveBeenCalled();
    expectCleanedUp();
  });

  it("does not reattach listeners after cancel during the initial read", async () => {
    let resolveLive;
    usage.active.mockReturnValueOnce(new Promise((resolve) => { resolveLive = resolve; }));
    open();
    response = await response;
    await vi.waitFor(() => expect(usage.active).toHaveBeenCalledTimes(1));
    const enqueue = vi.spyOn(ReadableStreamDefaultController.prototype, "enqueue");

    const canceled = response.body.cancel();
    resolveLive(LIVE);
    await canceled;
    await afterPendingWork();
    expect(enqueue).not.toHaveBeenCalled();
    expectCleanedUp();
    response = null;
  });
});
