// Benchmark: getCapabilitiesForModel lookup cost per model shape.
// Run: cd tests && ./node_modules/.bin/vitest run --config ./vitest.benchmark.config.js unit/capabilities-benchmark.test.js
// Results go to $CAP_BENCH_OUT (default /tmp/capabilities-benchmark.txt) since vitest hides console.log.
import fs from "node:fs";
import { describe, it } from "vitest";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";

const N = 10_000;
const OUT = process.env.CAP_BENCH_OUT || "/tmp/capabilities-benchmark.txt";

const CASES = [
  ["exact (openai/gpt-6-sol)", "openai", "gpt-6-sol"],
  ["pattern (openai/gpt-4o)", "openai", "gpt-4o"],
  ["unlisted (openai/totally-unknown-model)", "openai", "totally-unknown-model"],
  ["production (anthropic-compatible-x/claude-opus-5-5)", "anthropic-compatible-x", "claude-opus-5-5"],
];

describe("getCapabilitiesForModel benchmark", () => {
  it(`${N} lookups per case`, () => {
    const lines = [];
    for (const [label, provider, model] of CASES) {
      for (let i = 0; i < 1000; i++) getCapabilitiesForModel(provider, model);
      const t0 = performance.now();
      for (let i = 0; i < N; i++) getCapabilitiesForModel(provider, model);
      const ms = performance.now() - t0;
      lines.push(`${label.padEnd(54)} total ${ms.toFixed(1).padStart(8)}ms  per call ${((ms * 1000) / N).toFixed(2).padStart(8)}µs`);
    }
    fs.writeFileSync(OUT, lines.join("\n") + "\n");
  });
});
