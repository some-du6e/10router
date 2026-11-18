import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "10router-usage-last-used-"));
process.env.DATA_DIR = dataDir;
vi.resetModules();

const { getAdapter } = await import("../../src/lib/db/driver.js");
const { getUsageStats, saveRequestUsage } = await import("../../src/lib/db/repos/usageRepo.js");

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
    expect(stats.byApiKey["sk-test-1234567890|gpt-x|openai"].lastUsed).toBe(newer);
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

  it("keeps a separate lastUsed per API key", async () => {
    const aAt = new Date(Date.now() - 2 * 3600000).toISOString();
    const bAt = new Date(Date.now() - 1800000).toISOString();
    await saveRequestUsage(entry(aAt, { model: "gpt-key", apiKey: "sk-key-aaaaaaaaaa" }));
    await saveRequestUsage(entry(bAt, { model: "gpt-key", apiKey: "sk-key-bbbbbbbbbb" }));

    const stats = await getUsageStats("all");
    expect(stats.byApiKey["sk-key-aaaaaaaaaa|gpt-key|openai"].lastUsed).toBe(aAt);
    expect(stats.byApiKey["sk-key-bbbbbbbbbb|gpt-key|openai"].lastUsed).toBe(bAt);
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
