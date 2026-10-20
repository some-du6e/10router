// Benchmark: concurrent account selection across providers.
// Run: cd tests && ./node_modules/.bin/vitest run --config ./vitest.benchmark.config.js selection-lock
// Results go to SELECTION_BENCH_OUT (default: os.tmpdir()/selection-lock-bench.json)
// because vitest hides console.log.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, beforeAll, afterAll, expect, vi } from "vitest";

// Simulates a slow pick (e.g. a slow proxy-pool lookup) on connections that ask for it.
const SLOW_MS = 20;
vi.mock("@/lib/network/connectionProxy", async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    resolveConnectionProxyConfig: async (data = {}) => {
      if (data.benchSlow) await new Promise((r) => setTimeout(r, SLOW_MS));
      return real.resolveConnectionProxyConfig(data);
    },
  };
});
vi.mock("@/sse/utils/logger.js", () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }));

const N = 50;
const originalDataDir = process.env.DATA_DIR;
let tempDir, db, auth;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "10router-bench-selection-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
  await db.updateSettings({ fallbackStrategy: "round-robin" });
  for (let i = 0; i < 3; i++) {
    await db.createProviderConnection({ provider: "openai", authType: "apikey", name: `fast-${i}`, apiKey: `k${i}`, isActive: true });
    await db.createProviderConnection({ provider: "anthropic", authType: "apikey", name: `slow-${i}`, apiKey: `s${i}`, isActive: true, providerSpecificData: { benchSlow: true } });
  }
  auth = await import("@/sse/services/auth.js");
});

afterAll(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

async function timed(providers) {
  const t0 = performance.now();
  const fastDone = [];
  await Promise.all(providers.map(async (p) => {
    const c = await auth.getProviderCredentials(p);
    expect(c?.connectionId).toBeTruthy();
    if (p === "openai") fastDone.push(performance.now() - t0);
  }));
  const total = performance.now() - t0;
  return { totalMs: +total.toFixed(1), fastMaxMs: fastDone.length ? +Math.max(...fastDone).toFixed(1) : null };
}

describe("selection lock benchmark", () => {
  it(`fires ${N} concurrent selections across 2 providers`, async () => {
    const mixed = Array.from({ length: N }, (_, i) => (i % 2 ? "openai" : "anthropic"));
    await timed(["openai", "anthropic"]); // warmup
    const results = {
      n: N,
      slowPickMs: SLOW_MS,
      fastOnly: await timed(Array(N / 2).fill("openai")),
      mixed: await timed(mixed),
    };
    const out = process.env.SELECTION_BENCH_OUT || path.join(os.tmpdir(), "selection-lock-bench.json");
    fs.writeFileSync(out, JSON.stringify(results, null, 2));
  }, 60000);
});
