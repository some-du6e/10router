import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const usage = vi.hoisted(() => ({ stats: vi.fn(), active: vi.fn() }));
vi.mock("@/lib/usageDb", async () => {
  const { EventEmitter } = await import("node:events");
  return { getUsageStats: usage.stats, getActiveRequests: usage.active, statsEmitter: new EventEmitter() };
});

import { statsEmitter } from "@/lib/usageDb";
import { GET } from "../../src/app/api/usage/stream/route.js";

const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
let response;
let reader;

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  statsEmitter.removeAllListeners();
  usage.stats.mockResolvedValue({ totalRequests: 3 });
  usage.active.mockResolvedValue({ activeRequests: [], recentRequests: [], errorProvider: "" });
  response = null;
  reader = null;
});

afterEach(async () => {
  reader?.releaseLock();
  await response?.body.cancel();
  statsEmitter.removeAllListeners();
  vi.useRealTimers();
});

async function connect(controller = new AbortController()) {
  response = await GET(new Request("http://localhost/api/usage/stream", { signal: controller.signal }));
  await settle();
  return controller;
}

function expectCleanedUp() {
  expect(statsEmitter.listenerCount("update")).toBe(0);
  expect(statsEmitter.listenerCount("pending")).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
}

describe("usage stream lifecycle", () => {
  it("sends initial stats and pending updates while connected", async () => {
    const controller = await connect();
    reader = response.body.getReader();
    const decoder = new TextDecoder();
    expect(decoder.decode((await reader.read()).value)).toBe('data: {"totalRequests":3}\n\n');
    usage.active.mockResolvedValueOnce({ activeRequests: [{ count: 1 }], recentRequests: [], errorProvider: "" });
    statsEmitter.emit("pending");
    await settle();
    expect(decoder.decode((await reader.read()).value)).toContain('"activeRequests":[{"count":1}]');
    controller.abort();
    expectCleanedUp();
    expect((await reader.read()).done).toBe(true);
    reader.releaseLock();
    expectCleanedUp();
  });

  it("cleans listeners and keepalive immediately on request abort", async () => {
    const controller = await connect();
    expect(statsEmitter.listenerCount("update")).toBe(1);
    expect(statsEmitter.listenerCount("pending")).toBe(1);
    expect(vi.getTimerCount()).toBe(1);
    controller.abort();
    expectCleanedUp();
  });

  it("does not subscribe after an initial database failure", async () => {
    usage.stats.mockRejectedValueOnce(new Error("DB unavailable"));
    await connect();
    expectCleanedUp();
    expect((await response.body.getReader().read()).done).toBe(true);
    response = null;
  });

  it("does not subscribe or enqueue after abort during initial stats loading", async () => {
    let resolveStats;
    usage.stats.mockReturnValueOnce(new Promise((resolve) => { resolveStats = resolve; }));
    const controller = await connect();
    controller.abort();
    resolveStats({ totalRequests: 3 });
    await settle();
    expectCleanedUp();
    reader = response.body.getReader();
    expect((await reader.read()).done).toBe(true);
    reader.releaseLock();
  });

  it("does not start work for an already aborted request", async () => {
    const controller = new AbortController();
    controller.abort();
    await connect(controller);
    expect(usage.stats).not.toHaveBeenCalled();
    expectCleanedUp();
  });

  it("does not reattach listeners after cancel during initial stats loading", async () => {
    let resolveStats;
    usage.stats.mockReturnValueOnce(new Promise((resolve) => { resolveStats = resolve; }));
    await connect();
    const canceled = response.body.cancel();
    resolveStats({ totalRequests: 3 });
    await canceled;
    await settle();
    expectCleanedUp();
  });
});
