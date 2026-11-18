// Benchmark: per-request CPU cost of capping observability fields.
// Run: cd tests && ./node_modules/.bin/vitest run --config ./vitest.benchmark.config.js unit/request-details-benchmark.test.js
// Results: $RD_BENCH_OUT (default /tmp/request-details-bench.txt)
import fs from "node:fs";
import { describe, it } from "vitest";
import { __test__ } from "../../src/lib/db/repos/requestDetailsRepo.js";

const { truncateField } = __test__;
const MAX = 5 * 1024;
const OUT = process.env.RD_BENCH_OUT || "/tmp/request-details-bench.txt";

// Claude Code-like body: system prompt, tool defs, alternating turns with tool_result blocks.
function makeBody(targetBytes) {
  const body = {
    model: "claude-sonnet-4-5",
    system: [{ type: "text", text: "You are Claude Code. ".repeat(200) }],
    tools: Array.from({ length: 20 }, (_, i) => ({ name: `tool_${i}`, description: "d".repeat(400), input_schema: { type: "object", properties: { a: { type: "string" } } } })),
    messages: [],
  };
  let i = 0;
  while (JSON.stringify(body).length < targetBytes) {
    body.messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: `toolu_${i}`, content: `line ${i}\n`.repeat(300) }] });
    body.messages.push({ role: "assistant", content: [{ type: "text", text: "ok ".repeat(200) }, { type: "tool_use", id: `toolu_${i + 1}`, name: "Read", input: { path: `/src/file${i}.js` } }] });
    i += 2;
  }
  return body;
}

function timeIt(fn, minMs = 1500) {
  for (let i = 0; i < 3; i++) fn();
  let n = 0;
  const t0 = performance.now();
  while (performance.now() - t0 < minMs) { fn(); n++; }
  return (performance.now() - t0) / n;
}

describe("requestDetails field capping", () => {
  it("bench", () => {
    const lines = [`requestDetails bench, maxJsonSize=${MAX}, node ${process.version}`];
    for (const [label, size] of [["50KB", 50e3], ["500KB", 500e3], ["2MB", 2e6]]) {
      const body = makeBody(size);
      const request = { ...body, stream: true };
      // One saved detail = request + providerRequest (+ small response fields), then the row stringify.
      const perDetail = () => {
        const rec = { request: truncateField(request, MAX), providerRequest: truncateField(body, MAX), response: truncateField({ content: "hi" }, MAX) };
        JSON.stringify(rec);
      };
      const field = timeIt(() => truncateField(body, MAX));
      const detail = timeIt(perDetail);
      lines.push(`${label.padEnd(6)} actual=${JSON.stringify(body).length}B  truncateField=${field.toFixed(2)}ms  perDetail=${detail.toFixed(2)}ms  perStreamingRequest(2 saves)=${(detail * 2).toFixed(2)}ms`);
    }
    fs.appendFileSync(OUT, lines.join("\n") + "\n\n");
  }, 120000);
});
