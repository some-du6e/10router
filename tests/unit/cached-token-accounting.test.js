// Local integration: a cache-bearing request flows through canonicalizeUsage →
// saveRequestUsage → getUsageStats, proving cached tokens are persisted,
// aggregated, and cost is computed correctly (the bug this branch fixes).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { canonicalizeUsage } from "../../open-sse/utils/usageTracking.js";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let db;
let adapter;

const claudeUsage = {
  prompt_tokens: 100,
  completion_tokens: 50,
  cache_read_input_tokens: 200,
  cache_creation_input_tokens: 30,
};
const openaiUsage = { prompt_tokens: 1000, completion_tokens: 200, cached_tokens: 600 };
const claudeCost = (100 * 3 + 200 * 0.3 + 30 * 3.75 + 50 * 15) / 1_000_000;
const openaiCost = (400 * 2.5 + 600 * 1.25 + 200 * 10) / 1_000_000;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "10router-cached-e2e-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
  const { getAdapter } = await import("@/lib/db/driver.js");
  adapter = await getAdapter();
  for (const entry of [
    {
      provider: "anthropic", model: "claude-sonnet-4-6", connectionId: "c-cache",
      tokens: canonicalizeUsage(claudeUsage), endpoint: "/v1/messages", status: "ok",
    },
    {
      provider: "openai", model: "gpt-4o", connectionId: "c-oai",
      tokens: canonicalizeUsage(openaiUsage), endpoint: "/v1/chat/completions", status: "ok",
    },
  ]) await db.saveRequestUsage(entry);
});

afterAll(async () => {
  try {
    await adapter?.close();
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  } finally {
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
  }
});

describe("cached-token end-to-end (persist + aggregate + cost)", () => {
  it("Claude cache usage: canonical prompt is inclusive, cached persisted, cost correct", async () => {
    // Raw Claude usage (cache-EXCLUSIVE prompt): input 100, cache_read 200, cache_creation 30, output 50
    const canonical = canonicalizeUsage(claudeUsage);
    expect(canonical.prompt_tokens).toBe(330); // inclusive
    expect(canonical.total_tokens).toBe(380);

    // Cost: nonCached=330-200-30=100 @3 + cached 200 @0.30 + creation 30 @3.75 + output 50 @15
    const hist = await db.getUsageHistory({ provider: "anthropic" });
    expect(hist.length).toBe(1);
    expect(hist[0].cost).toBeCloseTo(claudeCost, 12);
    expect(hist[0].tokens).toEqual(canonical);
    expect(hist[0].tokens.cached_tokens).toBe(200);
    expect(hist[0].tokens.cache_creation_input_tokens).toBe(30);
  });

  it("OpenAI cache usage: inclusive prompt passes through, cached counted once", async () => {
    const canonical = canonicalizeUsage(openaiUsage);
    expect(canonical.prompt_tokens).toBe(1000);
    expect(canonical.cached_tokens).toBe(600);

    const hist = await db.getUsageHistory({ provider: "openai" });
    expect(hist).toHaveLength(1);
    expect(hist[0].cost).toBeCloseTo(openaiCost, 12);
    expect(hist[0].tokens).toEqual({
      prompt_tokens: 1000, completion_tokens: 200, total_tokens: 1200,
      cached_tokens: 600, cache_creation_input_tokens: 0,
    });
    expect(hist[0].tokens.prompt_tokens).toBe(1000);
    expect(hist[0].tokens.cached_tokens).toBe(600);
  });

  it.each(["24h", "7d"])("aggregates both requests and their costs over %s", async (period) => {
    const stats = await db.getUsageStats(period);
    expect(stats.totalRequests).toBe(2);
    expect(stats.totalCachedTokens).toBe(800);
    expect(stats.totalPromptTokens).toBe(1330);
    expect(stats.totalCompletionTokens).toBe(250);
    expect(stats.totalCost).toBeCloseTo(claudeCost + openaiCost, 12);
    expect(stats.byProvider.anthropic).toMatchObject({
      requests: 1, cachedTokens: 200, promptTokens: 330, completionTokens: 50,
    });
    expect(stats.byProvider.openai).toMatchObject({
      requests: 1, cachedTokens: 600, promptTokens: 1000, completionTokens: 200,
    });
    expect(stats.byProvider.anthropic.cost).toBeCloseTo(claudeCost, 12);
    expect(stats.byProvider.openai.cost).toBeCloseTo(openaiCost, 12);
  });

  it("retains both requests and cached usage after closing and reopening the database", async () => {
    await adapter.close();
    adapter = null;
    // Reset the driver's singleton so reads must come from a new connection to disk.
    delete global._dbAdapter;
    vi.resetModules();
    db = await import("@/lib/db/index.js");
    await db.initDb();
    const { getAdapter } = await import("@/lib/db/driver.js");
    adapter = await getAdapter();

    const hist = await db.getUsageHistory();
    expect(hist).toHaveLength(2);
    const anthropic = hist.find((entry) => entry.provider === "anthropic");
    const openai = hist.find((entry) => entry.provider === "openai");
    expect(anthropic).toMatchObject({
      provider: "anthropic", model: "claude-sonnet-4-6", connectionId: "c-cache",
      endpoint: "/v1/messages", status: "ok",
      tokens: {
        prompt_tokens: 330, completion_tokens: 50, total_tokens: 380,
        cached_tokens: 200, cache_creation_input_tokens: 30,
      },
    });
    expect(openai).toMatchObject({
      provider: "openai", model: "gpt-4o", connectionId: "c-oai",
      endpoint: "/v1/chat/completions", status: "ok",
      tokens: {
        prompt_tokens: 1000, completion_tokens: 200, total_tokens: 1200,
        cached_tokens: 600, cache_creation_input_tokens: 0,
      },
    });
    expect(anthropic.cost).toBeCloseTo(claudeCost, 12);
    expect(openai.cost).toBeCloseTo(openaiCost, 12);
    const stats = await db.getUsageStats("7d");
    expect(stats.totalCachedTokens).toBe(800);
    expect(stats.totalCost).toBeCloseTo(claudeCost + openaiCost, 12);
  });
});
