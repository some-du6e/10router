import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const dbRoot = process.env.DB_AUDIT_ROOT || path.resolve(import.meta.dirname, "../../src/lib/db");
const originalDataDir = process.env.DATA_DIR;
let dir;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "db-stats-masking-"));
  process.env.DATA_DIR = dir;
  delete global._dbAdapter;
  vi.resetModules();
});

afterEach(() => {
  vi.useRealTimers();
  global._dbAdapter?.instance?.close();
  delete global._dbAdapter;
  fs.rmSync(dir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

it("masks API keys in daily-summary property names as well as values", async () => {
  const secret = "sk-audit-complete-secret-value";
  const { saveRequestUsage, getUsageStats } = await import(`${dbRoot}/repos/usageRepo.js`);
  await saveRequestUsage({ provider: "audit", model: "model", apiKey: secret, tokens: { prompt_tokens: 10, completion_tokens: 5 } });
  const daily = await getUsageStats("7d");
  const live = await getUsageStats("24h");
  expect(JSON.stringify(daily)).not.toContain(secret);
  expect(Object.keys(daily.byApiKey)).toEqual(Object.keys(live.byApiKey));
  const entry = Object.values(daily.byApiKey)[0];
  expect(entry.requests).toBe(1);
  expect(entry.promptTokens).toBe(10);
  expect(entry.apiKeyMasked).toBe("sk-audit***");
  expect(entry.lastUsed).toBe(Object.values(live.byApiKey)[0].lastUsed);
});

it("keeps two real keys from the same machine separate in daily and live stats", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 9, 12, 12));
  const { createApiKey } = await import(`${dbRoot}/repos/apiKeysRepo.js`);
  const { saveRequestUsage, getUsageStats } = await import(`${dbRoot}/repos/usageRepo.js`);
  const first = await createApiKey("First", "1234567890abcdef");
  const second = await createApiKey("Second", "1234567890abcdef");
  expect(first.key).not.toBe(second.key);
  expect(first.key.slice(0, 8)).toBe(second.key.slice(0, 8));
  const firstTime = new Date(Date.now() - 2000).toISOString();
  const secondTime = new Date(Date.now() - 1000).toISOString();
  await saveRequestUsage({ provider: "audit", model: "model", apiKey: first.key, timestamp: firstTime, tokens: { prompt_tokens: 10, completion_tokens: 3 } });
  await saveRequestUsage({ provider: "audit", model: "model", apiKey: second.key, timestamp: secondTime, tokens: { prompt_tokens: 20, completion_tokens: 7 } });

  let groups;
  for (const period of ["7d", "all", "24h", "today"]) {
    const stats = await getUsageStats(period);
    expect(JSON.stringify(stats)).not.toContain(first.key);
    expect(JSON.stringify(stats)).not.toContain(second.key);
    const entries = Object.values(stats.byApiKey).sort((a, b) => a.keyName.localeCompare(b.keyName));
    expect(entries.map(({ keyName, requests, promptTokens, completionTokens, lastUsed }) => ({ keyName, requests, promptTokens, completionTokens, lastUsed }))).toEqual([
      { keyName: "First", requests: 1, promptTokens: 10, completionTokens: 3, lastUsed: firstTime },
      { keyName: "Second", requests: 1, promptTokens: 20, completionTokens: 7, lastUsed: secondTime },
    ]);
    expect(entries[0].apiKeyMasked).toBe(entries[1].apiKeyMasked);
    expect(entries[0].apiKeyKey).not.toBe(entries[1].apiKeyKey);
    const periodGroups = Object.keys(stats.byApiKey).sort();
    if (groups) expect(periodGroups).toEqual(groups);
    groups = periodGroups;
  }
});
