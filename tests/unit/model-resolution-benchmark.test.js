// Benchmark: per-request model resolution (combo check + getModelInfo), as
// src/sse/handlers/chat.js runs it. Vitest hides console.log, so results go to
// MODEL_BENCH_OUT (default /tmp/model-resolution-bench.txt).
// Run: cd tests && ./node_modules/.bin/vitest run --config ./vitest.benchmark.config.js model-resolution-benchmark
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const N = 1000;
const OUT = process.env.MODEL_BENCH_OUT || path.join(os.tmpdir(), "model-resolution-bench.txt");
const originalDataDir = process.env.DATA_DIR;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "10router-model-bench-"));
let db, model;
const lines = [];

beforeAll(async () => {
  process.env.DATA_DIR = dataDir;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  model = await import("@/sse/services/model.js");
  lines.push(`driver: ${(await (await import("@/lib/db/driver.js")).getAdapter()).driver}, aliases ${+process.env.N_ALIAS || 50}, nodes ${2 * (+process.env.N_NODE || 10)}`);
  for (let i = 0; i < (+process.env.N_ALIAS || 50); i++) await db.setModelAlias(`alias-${i}`, `openai/gpt-${i}`);
  for (let i = 0; i < (+process.env.N_NODE || 10); i++) {
    await db.createProviderNode({ type: "openai-compatible", name: `n${i}`, prefix: `node${i}`, baseUrl: "http://x" });
    await db.createProviderNode({ type: "anthropic-compatible", name: `a${i}`, prefix: `anode${i}`, baseUrl: "http://x" });
  }
  for (let i = 0; i < 10; i++) await db.createCombo({ name: `combo-${i}`, models: ["openai/gpt-4o", "claude/sonnet"] });
});

afterAll(() => {
  fs.writeFileSync(OUT, lines.join("\n") + "\n");
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

async function resolve(modelStr) {
  const combo = await model.getComboModels(modelStr);
  if (combo) return combo;
  return model.getModelInfo(modelStr);
}

const CASES = [
  ["built-in prefix (openai/gpt-4o)", "openai/gpt-4o"],
  ["custom node prefix (last node)", `anode${(+process.env.N_NODE || 10) - 1}/m`],
  ["bare alias (alias-25)", "alias-25"],
  ["combo (combo-5)", "combo-5"],
];

describe("model resolution benchmark", () => {
  it(`resolves ${N} requests per case`, async () => {
    lines.push(`model resolution, ${N} iterations, ${new Date().toISOString()}`);
    for (const [label, str] of CASES) {
      for (let i = 0; i < 100; i++) await resolve(str);
      const t0 = performance.now();
      for (let i = 0; i < N; i++) await resolve(str);
      const ms = performance.now() - t0;
      lines.push(`${label.padEnd(36)} total ${ms.toFixed(2)}ms  per-req ${(ms / N * 1000).toFixed(1)}us`);
      expect(await resolve(str)).toBeTruthy();
    }
  });
});
