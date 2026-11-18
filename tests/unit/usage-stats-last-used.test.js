import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "10router-usage-last-used-"));
process.env.DATA_DIR = dataDir;
vi.resetModules();

const { getAdapter } = await import("../../src/lib/db/driver.js");
const {
  apiKeyStatsKey, getActiveRequests, getUsageStats, saveRequestUsage, trackPendingRequest,
} = await import("../../src/lib/db/repos/usageRepo.js");

afterAll(() => {
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const entry = (timestamp, extra = {}) => ({
  timestamp,
  provider: "openai",
  model: "gpt-x",
  connectionId: "conn-1",
  apiKey: "sk-test-1234567890",
  endpoint: "/v1/chat/completions",
  tokens: { prompt_tokens: 10, completion_tokens: 5 },
  ...extra,
});

describe("getUsageStats lastUsed", () => {
  it("reports the newest timestamp per model, account, key and endpoint", async () => {
    const older = new Date(Date.now() - 3 * 3600000).toISOString();
    const newer = new Date(Date.now() - 3600000).toISOString();
    await saveRequestUsage(entry(newer));
    await saveRequestUsage(entry(older));

    const stats = await getUsageStats("all");
    expect(stats.byModel["gpt-x (openai)"].lastUsed).toBe(newer);
    expect(Object.values(stats.byAccount)[0].lastUsed).toBe(newer);
    expect(stats.byApiKey[apiKeyStatsKey("sk-test-1234567890", "gpt-x", "openai")].lastUsed).toBe(newer);
    expect(stats.byEndpoint["/v1/chat/completions|gpt-x|openai"].lastUsed).toBe(newer);
  });

  it("keeps a separate lastUsed per endpoint", async () => {
    const chatAt = new Date(Date.now() - 2 * 3600000).toISOString();
    const messagesAt = new Date(Date.now() - 1800000).toISOString();
    await saveRequestUsage(entry(chatAt, { model: "gpt-ep" }));
    await saveRequestUsage(entry(messagesAt, { model: "gpt-ep", endpoint: "/v1/messages" }));

    const stats = await getUsageStats("all");
    expect(stats.byEndpoint["/v1/chat/completions|gpt-ep|openai"].lastUsed).toBe(chatAt);
    expect(stats.byEndpoint["/v1/messages|gpt-ep|openai"].lastUsed).toBe(messagesAt);
  });

  it("keeps a separate lastUsed per account", async () => {
    const aAt = new Date(Date.now() - 2 * 3600000).toISOString();
    const bAt = new Date(Date.now() - 1800000).toISOString();
    await saveRequestUsage(entry(aAt, { model: "gpt-acct", connectionId: "conn-a" }));
    await saveRequestUsage(entry(bAt, { model: "gpt-acct", connectionId: "conn-b" }));

    const stats = await getUsageStats("all");
    const lastUsed = Object.entries(stats.byAccount)
      .filter(([k]) => k.startsWith("gpt-acct "))
      .map(([, v]) => v.lastUsed)
      .sort();
    expect(lastUsed).toEqual([aAt, bAt]);
  });

  // Keys made on one machine share their first 8 characters, the masked part.
  it.each(["all", "7d", "24h"])("keeps a separate row and lastUsed per API key (%s)", async (period) => {
    const model = `gpt-key-${period}`;
    const aAt = new Date(Date.now() - 2 * 3600000).toISOString();
    const bAt = new Date(Date.now() - 1800000).toISOString();
    await saveRequestUsage(entry(aAt, { model, apiKey: "sk-mach1-aaaaaaaaaa" }));
    await saveRequestUsage(entry(bAt, { model, apiKey: "sk-mach1-bbbbbbbbbb" }));

    const stats = await getUsageStats(period);
    const a = stats.byApiKey[apiKeyStatsKey("sk-mach1-aaaaaaaaaa", model, "openai")];
    const b = stats.byApiKey[apiKeyStatsKey("sk-mach1-bbbbbbbbbb", model, "openai")];
    expect(a).toMatchObject({ requests: 1, rawModel: model, apiKeyMasked: "sk-mach1***" });
    expect(b).toMatchObject({ requests: 1, rawModel: model, apiKeyMasked: "sk-mach1***" });
    // Unknown keys are labelled with the masked key and a tag, so the
    // dashboard (which groups by keyName) keeps them apart.
    expect(a.keyName).toMatch(/^sk-mach1\*\*\* #[0-9a-f]{6}$/);
    expect(b.keyName).toMatch(/^sk-mach1\*\*\* #[0-9a-f]{6}$/);
    expect(a.keyName).not.toBe(b.keyName);
    expect(a.lastUsed).toBe(aAt);
    expect(b.lastUsed).toBe(bAt);
  });

  it("does not let an older request saved later replace a newer lastUsed", async () => {
    await getUsageStats("all");
    const newer = new Date(Date.now() - 1800000).toISOString();
    const older = new Date(Date.now() - 3 * 3600000).toISOString();
    await saveRequestUsage(entry(newer, { model: "gpt-order" }));
    await saveRequestUsage(entry(older, { model: "gpt-order" }));

    expect((await getUsageStats("all")).byModel["gpt-order (openai)"].lastUsed).toBe(newer);
  });

  it("reports the precise lastUsed for bounded periods", async () => {
    const at = new Date(Date.now() - 3600000).toISOString();
    await saveRequestUsage(entry(at, { model: "gpt-7d" }));

    expect((await getUsageStats("7d")).byModel["gpt-7d (openai)"].lastUsed).toBe(at);
  });

  it("picks up requests saved after the first stats call", async () => {
    await getUsageStats("all");
    const latest = new Date(Date.now() - 60000).toISOString();
    await saveRequestUsage(entry(latest));
    expect((await getUsageStats("all")).byModel["gpt-x (openai)"].lastUsed).toBe(latest);
  });

  it("does not rescan usage history on repeated calls", async () => {
    await getUsageStats("all");
    const db = await getAdapter();
    const queries = [];
    const all = db.all.bind(db);
    db.all = (sql, params) => { queries.push(sql); return all(sql, params); };
    try {
      await getUsageStats("all");
    } finally {
      db.all = all;
    }
    const fullScans = queries.filter((q) => /FROM usageHistory/.test(q) && !/LIMIT|timestamp <= \?/.test(q));
    expect(fullScans).toEqual([]);
  });

  it("shares one computation between concurrent callers", async () => {
    const [a, b] = await Promise.all([getUsageStats("all"), getUsageStats("all")]);
    expect(a).toBe(b);
  });
});

describe("API keys in usage responses", () => {
  const rawKey = "sk-placeholder-secret-0001";
  const model = "gpt-leak";

  it.each(["24h", "7d", "30d", "60d", "all"])("the %s stats never contain the raw key", async (period) => {
    await saveRequestUsage(entry(new Date(Date.now() - 60000).toISOString(), { model, apiKey: rawKey }));
    const stats = await getUsageStats(period);

    expect(JSON.stringify(stats)).not.toContain(rawKey.slice(0, 12));
    const rows = Object.values(stats.byApiKey).filter((row) => row.rawModel === model);
    expect(rows).toHaveLength(1);
    expect(rows[0].apiKeyMasked).toBe("sk-place***");
    expect(rows[0].keyName).toMatch(/^sk-place\*\*\* #[0-9a-f]{6}$/);
  });

  it.each(["24h", "all"])("labels a short key without showing it (%s)", async (period) => {
    const shortKey = "sk-tiny9";
    await saveRequestUsage(entry(new Date(Date.now() - 60000).toISOString(), { model: "gpt-short", apiKey: shortKey }));
    const stats = await getUsageStats(period);
    const row = stats.byApiKey[apiKeyStatsKey(shortKey, "gpt-short", "openai")];

    expect(row.apiKeyMasked).toBe("s***");
    expect(row.keyName).toMatch(/^s\*\*\* #[0-9a-f]{6}$/);
    expect(JSON.stringify(stats)).not.toContain(shortKey);
  });

  it("keys the row id with a server secret, not a plain hash of the key", () => {
    const id = apiKeyStatsKey(rawKey, model, "openai").split("|")[0];
    expect(id).toMatch(/^key-[0-9a-f]{16}$/);
    expect(id).not.toBe(`key-${createHash("sha256").update(rawKey).digest("hex").slice(0, 16)}`);
  });

  it("keeps no-key traffic in one row per model on Today/24h too", async () => {
    const at = new Date(Date.now() - 60000).toISOString();
    await saveRequestUsage(entry(at, { model: "gpt-local-a", apiKey: undefined }));
    await saveRequestUsage(entry(at, { model: "gpt-local-b", apiKey: undefined }));
    const stats = await getUsageStats("24h");

    expect(stats.byApiKey["local-no-key"]).toBeUndefined();
    expect(stats.byApiKey["local-no-key|gpt-local-a|openai"]).toMatchObject({ requests: 1, rawModel: "gpt-local-a", keyName: "Local (No API Key)", apiKeyMasked: null });
    expect(stats.byApiKey["local-no-key|gpt-local-b|openai"]).toMatchObject({ requests: 1, rawModel: "gpt-local-b" });
  });

  it("masks a legacy daily row that has no stored key, model or provider", async () => {
    const legacyKey = "sk-legacy-rawkey-0001";
    const counts = { requests: 2, promptTokens: 3, completionTokens: 4, cachedTokens: 0, cost: 0 };
    const db = await getAdapter();
    db.run(`INSERT OR REPLACE INTO usageDaily(dateKey, data) VALUES(?, ?)`, [
      "2020-01-01",
      JSON.stringify({ ...counts, byApiKey: { [`${legacyKey}|gpt-legacy|openai`]: counts } }),
    ]);
    const stats = await getUsageStats("all");

    expect(JSON.stringify(stats)).not.toContain(legacyKey.slice(0, 12));
    expect(stats.byApiKey[apiKeyStatsKey(legacyKey, "gpt-legacy", "openai")]).toMatchObject({
      requests: 2, rawModel: "gpt-legacy", provider: "openai", apiKeyMasked: "sk-legac***",
    });
  });

  const historyRoute = () => import("../../src/app/api/usage/history/route.js");
  const statsRoute = () => import("../../src/app/api/usage/stats/route.js");

  it.each([
    ["history", historyRoute, undefined],
    ["stats (default 7d)", statsRoute, "http://localhost/api/usage/stats"],
    ["stats 30d", statsRoute, "http://localhost/api/usage/stats?period=30d"],
    ["stats all", statsRoute, "http://localhost/api/usage/stats?period=all"],
  ])("the %s route never returns the raw key", async (_name, loadRoute, url) => {
    await saveRequestUsage(entry(new Date(Date.now() - 60000).toISOString(), { model, apiKey: rawKey }));
    const { GET } = await loadRoute();
    const res = await GET(url ? new Request(url) : undefined);
    const body = await res.text();

    expect(res.status).toBe(200);
    expect(body).toContain(model);
    expect(body).not.toContain(rawKey.slice(0, 12));
  });
});

describe("getActiveRequests", () => {
  it("reports requests in flight in pending", async () => {
    trackPendingRequest("gpt-pending", "openai", "conn-pending", true);
    try {
      const { pending } = await getActiveRequests();
      expect(pending.byModel["gpt-pending (openai)"]).toBe(1);
      expect(pending.byAccount["conn-pending"]["gpt-pending (openai)"]).toBe(1);
    } finally {
      trackPendingRequest("gpt-pending", "openai", "conn-pending", false);
    }
    expect((await getActiveRequests()).pending.byModel["gpt-pending (openai)"]).toBeUndefined();
  });

  it("lists the same recent requests as the stats after many duplicates", async () => {
    const base = Date.now() - 50000;
    for (let i = 0; i < 20; i++) {
      await saveRequestUsage(entry(new Date(base + i * 1000).toISOString(), { model: `gpt-ring-${i}` }));
    }
    const dupAt = new Date(Date.now() - 5000).toISOString();
    for (let i = 0; i < 60; i++) await saveRequestUsage(entry(dupAt, { model: "gpt-ring-dup" }));

    const pick = ({ timestamp, model, provider, promptTokens, completionTokens }) => ({ timestamp, model, provider, promptTokens, completionTokens });
    const live = (await getActiveRequests()).recentRequests.map(pick);
    const stats = (await getUsageStats("24h")).recentRequests.map(pick);
    expect(live).toHaveLength(20);
    expect(live).toEqual(stats);
  });
});
