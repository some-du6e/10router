// The gateway's hot-path queries on modernc.org/sqlite (pure Go) against the
// same queries through Node's drivers, on one seeded file (docs/GO_GATEWAY.md,
// Risks: "Driver performance"). Reports only; it asserts nothing about speed.
//
//   GATEWAY_DBTOOL=/path/to/gateway-dbtool ./node_modules/.bin/vitest run \
//     --config ./vitest.benchmark.config.js bench/gateway-db-benchmark.test.js
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { performance } from "node:perf_hooks";
import { afterAll, expect, it } from "vitest";
import { closeRepos, driverAvailable, openRepos, tempDataDir } from "../helpers/nodeDb.js";

const TOOL = process.env.GATEWAY_DBTOOL;
const PROVIDER = "bench";
const CONNECTIONS = 50;
const KEYS = 1000;
const ITERS = 2000;

const dirs = [];
afterAll(() => {
  closeRepos();
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

async function usPerOp(n, fn) {
  for (let i = 0; i < Math.min(n, 50); i++) await fn(i);
  const start = performance.now();
  for (let i = 0; i < n; i++) await fn(i);
  return Math.round(((performance.now() - start) * 1000) / n * 10) / 10;
}

async function seed(repos) {
  for (let i = 0; i < CONNECTIONS; i++) {
    await repos.createProviderConnection({
      provider: PROVIDER, authType: "apikey", name: `b${i}`, apiKey: `upstream-${i}`,
      providerSpecificData: {
        baseUrl: "http://upstream.invalid/v1",
        enabledModels: Array.from({ length: 30 }, (_, m) => `model-${m}`),
        modelRoutes: Object.fromEntries(Array.from({ length: 10 }, (_, m) => [`model-${m}`, "anthropic"])),
      },
    });
  }
  const keys = [];
  for (let i = 0; i < KEYS; i++) keys.push((await repos.createApiKey(`client ${i}`, "machine-1")).key);
  return keys;
}

const drivers = [];
for (const d of ["better-sqlite3", "node:sqlite"]) if (await driverAvailable(d)) drivers.push(d);

it.skipIf(!TOOL || !drivers.length)("hot-path queries: modernc.org/sqlite vs Node's drivers", async () => {
  const results = [];
  let goResult = null;
  for (const driver of drivers) {
    const dir = tempDataDir("gw-bench-");
    dirs.push(dir);
    const { repos, file } = await openRepos(driver, dir);
    const keys = await seed(repos);
    const list = await usPerOp(ITERS, () => repos.getProviderConnections({ provider: PROVIDER, isActive: true }));
    const key = await usPerOp(ITERS * 5, (i) => repos.getApiKeyPolicy(keys[i % keys.length]));
    // Node writes each request's usage in its own transaction.
    const usage = await usPerOp(1000, (i) => repos.saveRequestUsage({
      provider: PROVIDER, model: "bench-model", connectionId: null, apiKey: keys[i % keys.length], endpoint: "/v1/messages",
      tokens: { input_tokens: 1200, output_tokens: 300 },
    }));
    results.push({ driver, list, key, usage });
    if (!goResult) {
      closeRepos();
      goResult = JSON.parse(execFileSync(TOOL, ["bench", "--db", file, "--provider", PROVIDER, "--iters", String(ITERS), "--batch", "50"], { encoding: "utf8" }));
    }
  }
  const md = [
    `### Gateway DB benchmark (${CONNECTIONS} connections listed, ${KEYS} keys, µs per op)`,
    "",
    "| query | " + results.map((r) => r.driver).join(" | ") + " | modernc.org/sqlite (Go) |",
    "|---|" + results.map(() => "---|").join("") + "---|",
    `| connection listing (${CONNECTIONS} rows, JSON parsed, sorted) | ${results.map((r) => r.list).join(" | ")} | ${goResult.listConnections.usPerOp.toFixed(1)} |`,
    `| key lookup | ${results.map((r) => r.key).join(" | ")} | ${goResult.keyLookup.usPerOp.toFixed(1)} |`,
    `| usage row, one per transaction | ${results.map((r) => r.usage).join(" | ")} | ${goResult.usageRow.usPerRowAlone.toFixed(1)} |`,
    `| usage row, batched ${goResult.usageRow.batch} per transaction | ${results.map(() => "-").join(" | ")} | ${goResult.usageRow.usPerRowBatched.toFixed(1)} |`,
    "",
  ].join("\n");
  console.log(md);
  console.log(`GATEWAY_DB_BENCH ${JSON.stringify({ node: results, go: goResult })}`);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${md}\n`);
  expect(goResult.listConnections.usPerOp).toBeGreaterThan(0);
}, 600_000);
