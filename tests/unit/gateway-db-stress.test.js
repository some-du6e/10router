// Node and the Go gateway hammering one database file (docs/GO_GATEWAY.md,
// Risks: "SQLite lock contention freezing Node"). Node runs a request loop
// (connection listing, key lookup, lock writes, usage, request details,
// dashboard config writes, a TRUNCATE checkpoint every 5 s), first alone,
// then while gateway-dbtool stress writes usage batches, connection locks and
// request details and polls for config changes. Node's event-loop lag must
// stay under 50 ms at p99 and no SQLITE_BUSY may surface on either side.
//
//   GATEWAY_DBTOOL=/path/to/gateway-dbtool ./node_modules/.bin/vitest run \
//     --config ./vitest.stress.config.js unit/gateway-db-stress.test.js
// GATEWAY_DB_STRESS_MS (default 30000) and GATEWAY_DB_STRESS_BASELINE_MS
// (10000) set the phases. Results go to stdout and GITHUB_STEP_SUMMARY.
import { spawn } from "node:child_process";
import fs from "node:fs";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { afterAll, describe, expect, it } from "vitest";
import { closeRepos, driverAvailable, openRepos, tempDataDir } from "../helpers/nodeDb.js";

const TOOL = process.env.GATEWAY_DBTOOL;
const SHARED_MS = Number(process.env.GATEWAY_DB_STRESS_MS || 30000);
const BASELINE_MS = Number(process.env.GATEWAY_DB_STRESS_BASELINE_MS || 10000);
const LAG_P99_LIMIT_MS = 50;
const PROVIDER = "stress";
const isBusy = (s) => /SQLITE_BUSY|database is locked/i.test(String(s));

const dirs = [];
afterAll(() => {
  closeRepos();
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

async function seed(repos) {
  await repos.updateSettings({ enableObservability: true, observabilityBatchSize: 20, observabilityMaxRecords: 500 });
  for (let i = 0; i < 20; i++) {
    await repos.createProviderConnection({
      provider: PROVIDER, authType: "apikey", name: `s${i}`, apiKey: `upstream-${i}`,
      providerSpecificData: { baseUrl: "http://upstream.invalid/v1", enabledModels: Array.from({ length: 30 }, (_, m) => `model-${m}`) },
    });
  }
  const keys = [];
  for (let i = 0; i < 200; i++) keys.push((await repos.createApiKey(`client ${i}`, "machine-1")).key);
  return keys;
}

const ms = (ns) => Math.round(ns / 1e4) / 100;

// One "request" every ~2 ms, as Node's request path makes them.
async function workload(durationMs, repos, adapter, keys) {
  const lag = monitorEventLoopDelay({ resolution: 1 });
  const busy = [];
  const errors = [];
  const checkpoints = [];
  const counts = { requests: 0, usage: 0, details: 0, lockWrites: 0, configWrites: 0 };
  // saveRequestUsage and the request-detail flush log their failures instead of throwing.
  const consoleError = console.error;
  console.error = (...args) => {
    const line = args.map((a) => (a instanceof Error ? a.message : String(a))).join(" ");
    (isBusy(line) ? busy : errors).push(line);
  };
  // Node's slowest calls, by name: what a stall was waiting in.
  const slow = [];
  const timed = async (name, fn) => {
    const t = performance.now();
    try {
      return await fn();
    } finally {
      const took = performance.now() - t;
      if (took >= 20) {
        slow.push({ name, ms: Math.round(took) });
        slow.sort((x, y) => y.ms - x.ms);
        slow.length = Math.min(slow.length, 10);
      }
    }
  };
  lag.enable();
  const end = Date.now() + durationMs;
  let lastConfig = 0;
  let lastCheckpoint = Date.now();
  try {
    while (Date.now() < end) {
      const n = ++counts.requests;
      try {
        const conns = await timed("getProviderConnections", () => repos.getProviderConnections({ provider: PROVIDER, isActive: true }));
        const c = conns[n % conns.length];
        const key = keys[n % keys.length];
        await timed("getApiKeyPolicy", () => repos.getApiKeyPolicy(key));
        const now = new Date().toISOString();
        if (n % 5 === 0) {
          await timed("lock write", () => repos.updateProviderConnection(c.id, {
            "modelLock_node-model": new Date(Date.now() + 30000).toISOString(), "modelLimit_node-model": true,
            testStatus: "unavailable", lastError: "rate limited", errorCode: 429, lastErrorAt: now, backoffLevel: 1,
          }));
          counts.lockWrites++;
        } else if (n % 5 === 1) {
          await timed("lock clear", () => repos.updateProviderConnection(c.id, {
            "modelLock_node-model": null, "modelLimit_node-model": null, testStatus: "active", lastError: null, errorCode: null, backoffLevel: 0,
          }, { liftDemote: "node-model" }));
          counts.lockWrites++;
        } else if (n % 5 === 2) {
          await timed("round-robin write", () => repos.updateProviderConnection(c.id, { lastUsedAt: now, consecutiveUseCount: n % 3 }));
          counts.lockWrites++;
        }
        await timed("saveRequestUsage", () => repos.saveRequestUsage({
          provider: PROVIDER, model: "node-model", connectionId: c.id, apiKey: key, endpoint: "/v1/messages",
          tokens: { input_tokens: 1000 + (n % 5000), output_tokens: n % 800, cache_read_input_tokens: n % 4000 },
        }));
        counts.usage++;
        if (n % 4 === 0) {
          await timed("saveRequestDetail", () => repos.saveRequestDetail({
            provider: PROVIDER, model: "node-model", connectionId: c.id, status: "success",
            latency: { ttft: 120, total: 900 }, request: { model: "node-model", messages: [{ role: "user", content: "synthetic" }] },
          }));
          counts.details++;
        }
        if (Date.now() - lastConfig >= 500) {
          await timed("updateSettings", () => repos.updateSettings({ stickyRoundRobinLimit: 3 + (n % 3) }));
          counts.configWrites++;
          lastConfig = Date.now();
        }
        if (Date.now() - lastCheckpoint >= 5000) {
          const t = performance.now();
          adapter.checkpoint();
          checkpoints.push(Math.round(performance.now() - t));
          lastCheckpoint = Date.now();
        }
      } catch (e) {
        (isBusy(e.message) ? busy : errors).push(e.message);
      }
      await new Promise((r) => setTimeout(r, 2));
    }
  } finally {
    lag.disable();
    console.error = consoleError;
  }
  return {
    ...counts,
    lagMs: { p50: ms(lag.percentile(50)), p99: ms(lag.percentile(99)), max: ms(lag.max) },
    checkpointsMs: checkpoints,
    slowest: slow,
    busy: busy.slice(0, 5), busyCount: busy.length,
    errors: errors.slice(0, 5), errorCount: errors.length,
  };
}

function runGateway(file, durationMs) {
  const child = spawn(TOOL, ["stress", "--db", file, "--duration", `${durationMs}ms`, "--provider", PROVIDER], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  let err = "";
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", (d) => { err += d; });
  return new Promise((resolve) => child.on("exit", (code) => resolve({ code, out, err })));
}

function report(driver, baseline, shared, gateway) {
  const row = (name, r) => `| ${name} | ${r.requests} | ${r.lagMs.p50} | ${r.lagMs.p99} | ${r.lagMs.max} | ${r.checkpointsMs.join(", ") || "-"} | ${r.busyCount} |`;
  const g = gateway.latency || {};
  const lat = (s) => (s ? `${s.p50Ms} / ${s.p99Ms} / ${s.maxMs} (${s.count})` : "-");
  const md = [
    `### Gateway DB stress: Node on ${driver}`,
    "",
    "| Node phase | requests | lag p50 ms | lag p99 ms | lag max ms | TRUNCATE checkpoints ms | SQLITE_BUSY |",
    "|---|---|---|---|---|---|---|",
    row("alone", baseline),
    row("with the gateway", shared),
    "",
    `Gateway: ${gateway.usageRows} usage rows, ${gateway.connectionWrites} connection writes, ${gateway.detailRows} request-detail rows, ${gateway.reads} reads, ${gateway.watch?.reloads} snapshot reloads (${gateway.generations?.length} generations), ${gateway.busyErrors} SQLITE_BUSY, ${gateway.errors} errors.`,
    "",
    "| Gateway op | p50 / p99 / max ms (count) |",
    "|---|---|",
    `| usage batch (100 ms) | ${lat(g.usageBatch)} |`,
    `| connection write | ${lat(g.connectionWrite)} |`,
    `| request-detail batch | ${lat(g.detailBatch)} |`,
    `| read (list + key) | ${lat(g.read)} |`,
    "",
    `Gateway write lock: ${gateway.lock ? `${gateway.lock.transactions} transactions for ${gateway.lock.writes} writes, held p50 ${gateway.lock.holdP50Ms} / p99 ${gateway.lock.holdP99Ms} / max ${gateway.lock.holdMaxMs} ms, waited p99 ${gateway.lock.waitP99Ms} / max ${gateway.lock.waitMaxMs} ms` : "-"}.`,
    `Node's slowest calls with the gateway: ${shared.slowest.map((s) => `${s.name} ${s.ms} ms`).join(", ") || "none over 20 ms"}.`,
    "",
  ].join("\n");
  console.log(md);
  console.log(`GATEWAY_DB_STRESS ${JSON.stringify({ driver, baseline, shared, gateway })}`);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${md}\n`);
}

for (const driver of ["better-sqlite3", "node:sqlite"]) {
  const available = TOOL && await driverAvailable(driver);
  describe.skipIf(!available)(`Node on ${driver} and the gateway on one file`, () => {
    it("keeps Node's event loop responsive and surfaces no SQLITE_BUSY", async () => {
      const dir = tempDataDir("gw-stress-");
      dirs.push(dir);
      const { repos, adapter, file } = await openRepos(driver, dir);
      expect(adapter.driver).toBe(driver);
      const keys = await seed(repos);

      const baseline = await workload(BASELINE_MS, repos, adapter, keys);
      const gatewayRun = runGateway(file, SHARED_MS);
      const shared = await workload(SHARED_MS, repos, adapter, keys);
      const { code, out, err } = await gatewayRun;
      const { __test__ } = await import("@/lib/db/repos/requestDetailsRepo.js");
      await __test__.flush();
      let gateway = {};
      try { gateway = JSON.parse(out); } catch { /* reported below */ }
      report(driver, baseline, shared, gateway);

      expect({ code, err: err.slice(0, 2000) }).toEqual({ code: 0, err: "" });
      expect(gateway).toMatchObject({ ok: true, errors: 0, busyErrors: 0, usageDropped: 0 });
      expect(shared.busy).toEqual([]);
      expect(shared.errors).toEqual([]);
      expect(baseline.errors).toEqual([]);
      expect(shared.lagMs.p99).toBeLessThan(LAG_P99_LIMIT_MS);
      // The gateway saw Node's config writes.
      expect(gateway.generations.length).toBeGreaterThan(2);
      // And it kept up with its load (500 usage rows/s, 100 connection writes/s):
      // a gateway that wrote little would leave Node nothing to wait for.
      const seconds = SHARED_MS / 1000;
      expect(gateway.usageRows).toBeGreaterThan(0.9 * 500 * seconds);
      expect(gateway.connectionWrites).toBeGreaterThan(0.8 * 100 * seconds);
      expect(gateway.connectionWritesSkipped).toBeLessThan(0.05 * 100 * seconds);

      // Nothing was lost: every row each side wrote is there, and the
      // counters both sides move add up.
      const count = (sql, p = []) => adapter.get(sql, p).n;
      const nodeRows = count(`SELECT COUNT(*) AS n FROM usageHistory WHERE model = 'node-model'`);
      const goRows = count(`SELECT COUNT(*) AS n FROM usageHistory WHERE model = 'gw-model'`);
      expect(nodeRows).toBe(baseline.usage + shared.usage);
      expect(goRows).toBe(gateway.usageRows);
      expect(Number(adapter.get(`SELECT value FROM _meta WHERE key = 'totalRequestsLifetime'`).value)).toBe(nodeRows + goRows);
      expect(count(`SELECT SUM(requestCount) AS n FROM apiKeys`)).toBe(nodeRows + goRows);
      // And Node reads every row the gateway rewrote.
      const conns = await repos.getProviderConnections({ provider: PROVIDER });
      expect(conns).toHaveLength(20);
      for (const row of adapter.all(`SELECT data FROM providerConnections`)) expect(() => JSON.parse(row.data)).not.toThrow();
      for (const row of adapter.all(`SELECT data FROM usageDaily`)) expect(JSON.parse(row.data).requests).toBeGreaterThan(0);
    }, BASELINE_MS + SHARED_MS + 120_000);
  });
}
