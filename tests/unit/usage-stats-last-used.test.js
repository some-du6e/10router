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
