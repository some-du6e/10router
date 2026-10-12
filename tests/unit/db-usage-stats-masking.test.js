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
