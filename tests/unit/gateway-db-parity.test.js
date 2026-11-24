// The Go gateway and Node on one database file (docs/GO_GATEWAY.md, SQLite
// sharing): the gateway's schema guard accepts a database this Node migrated,
// its readers read what Node's repos read, and the rows its writers make are
// byte for byte the rows Node's repos make for the same writes.
//
// Needs the gateway-dbtool binary: GATEWAY_DBTOOL=/path/to/gateway-dbtool
// (.github/workflows/gateway-db.yml builds it). Skipped without it.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { closeRepos, driverAvailable, generation, openRepos, tempDataDir } from "../helpers/nodeDb.js";

const TOOL = process.env.GATEWAY_DBTOOL;
const NOW = "2026-03-01T12:00:00.000Z";
const LATER = "2026-03-01T12:05:00.000Z";

const dirs = [];
afterEach(() => {
  vi.useRealTimers();
  closeRepos();
});
afterAll(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

function tool(args) {
  const r = spawnSync(TOOL, args, { encoding: "utf8" });
  if (r.error) throw r.error;
  return { code: r.status, out: r.stdout, err: r.stderr };
}

function check(file) {
  const r = tool(["check", "--db", file]);
  return { code: r.code, status: JSON.parse(r.out) };
}

function applyGo(file, ops) {
  const opsFile = `${file}.ops.json`;
  fs.writeFileSync(opsFile, JSON.stringify(ops));
  return JSON.parse(execFileSync(TOOL, ["apply", "--db", file, "--ops", opsFile, "--now", NOW], { encoding: "utf8" }));
}

const json = (v) => JSON.stringify(v);

// Every row of a table, for comparing two files column by column.
function rows(adapter, table, order) {
  return adapter.all(`SELECT * FROM ${table} ORDER BY ${order}`).map((r) =>
    Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v instanceof Uint8Array ? Buffer.from(v).toString("base64") : v])));
}

const drivers = [];
for (const d of ["better-sqlite3", "node:sqlite"]) if (await driverAvailable(d)) drivers.push(d);

describe.skipIf(!TOOL)("the gateway's schema guard", () => {
  for (const driver of drivers) {
    it(`accepts a database ${driver} migrated`, async () => {
      const dir = tempDataDir("gw-guard-");
      dirs.push(dir);
      const { file } = await openRepos(driver, dir);
      const { latestVersion } = await import("@/lib/db/migrations/index.js");
      const { code, status } = check(file);
      expect(status).toMatchObject({ ready: true, driver, schemaVersion: latestVersion() });
      expect(code).toBe(0);
    });
  }

  it("refuses a database sql.js keeps", async () => {
    const dir = tempDataDir("gw-guard-");
    dirs.push(dir);
    const { file } = await openRepos("sql.js", dir);
    closeRepos(); // writes the file
    const { code, status } = check(file);
    expect(status.ready).toBe(false);
    expect(status.reason).toMatch(/sql\.js/);
    expect(code).toBe(3);
  });

  it("refuses a schema newer than it knows, or one missing a column it reads", async () => {
    const dir = tempDataDir("gw-guard-");
    dirs.push(dir);
    const { adapter, file } = await openRepos(drivers[0], dir);
    adapter.run(`UPDATE _meta SET value = '999' WHERE key = 'schemaVersion'`);
    expect(check(file).status.reason).toMatch(/schema version 999 is newer/);
    adapter.run(`UPDATE _meta SET value = '6' WHERE key = 'schemaVersion'`);
    adapter.exec(`ALTER TABLE combos DROP COLUMN kind`);
    expect(check(file).status.reason).toMatch(/table combos has no column kind/);
  });
});

// The config a dashboard would set up.
async function seedConfig(repos) {
  await repos.updateSettings({ requireApiKey: false, comboStrategy: "round-robin", enableObservability: true, observabilityMaxRecords: 3, observabilityBatchSize: 100, mitmEnabled: true, extraSetting: { a: [1, 2] } });
  const node = await repos.createProviderNode({
    id: "openai-compatible-chat-gw", type: "openai-compatible", name: "GW", prefix: "gw", apiType: "chat", baseUrl: "http://upstream.invalid/v1",
    modelRoutes: { "m1": "anthropic" }, droppedBetas: ["b-1"], overrides: { headers: [] },
  });
  await repos.createCombo({ name: "fast", models: ["gw/m1", "gw/m2"] });
  await repos.createCombo({ name: "slow", kind: "auto", models: [] });
  const c1 = await repos.createProviderConnection({ provider: node.id, authType: "apikey", name: "k1", apiKey: "upstream-key-1", providerSpecificData: { baseUrl: "http://upstream.invalid/v1", droppedBetas: ["a-1"] } });
  const c2 = await repos.createProviderConnection({ provider: node.id, authType: "apikey", name: "k2", apiKey: "upstream-key-2", priority: 5 });
  const c3 = await repos.createProviderConnection({ provider: node.id, authType: "apikey", name: "k3", apiKey: "upstream-key-3" });
  await repos.updateProviderConnection(c3.id, { isActive: false });
  const key1 = await repos.createApiKey("client one", "machine-1");
  const key2 = await repos.createApiKey("client two", "machine-1");
  await repos.updateApiKey(key2.id, { budgetUsd: 2.5, allowedModels: ["fast", "gw/m1"], expiresAt: "2027-01-01T00:00:00.000Z", limitHold: false });
  await repos.setModelAlias("sonnet", "gw/m1");
  await repos.addCustomModel({ providerAlias: "gw", id: "m1", name: "Model one" });
  await repos.updatePricing({ [node.id]: { m1: { input: 3, output: 15, cached: 0.3 } } });
  const pool = await repos.createProxyPool({ name: "pool", proxyUrl: "http://proxy.invalid:8080" });
  return { node, c1, c2, c3, key1, key2, pool };
}

describe.skipIf(!TOOL)("Go reads what Node wrote", () => {
  for (const driver of drivers) {
    it(`on ${driver}`, async () => {
      const dir = tempDataDir("gw-read-");
      dirs.push(dir);
      const { repos, adapter, file } = await openRepos(driver, dir);
      const s = await seedConfig(repos);
      await repos.saveRequestUsage({ provider: s.node.id, model: "m1", apiKey: s.key1.key, tokens: { input_tokens: 1000, output_tokens: 10 } });

      const dump = JSON.parse(execFileSync(TOOL, ["dump", "--db", file, "--pools", `${s.pool.id},missing`], { encoding: "utf8" }));
      expect(json(dump.settings)).toBe(json(await repos.getSettings()));
      for (const name of ["fast", "slow"]) expect(json(dump.combos[name])).toBe(json(await repos.getComboByName(name)));
      expect(json(dump.nodes)).toBe(json(await repos.getProviderNodes()));
      expect(json(dump.apiKeys)).toBe(json(await repos.getApiKeys()));
      expect(json(dump.modelAliases)).toBe(json(await repos.getModelAliases()));
      expect(json(dump.customModels)).toBe(json(await repos.getCustomModels()));
      const { makeKv } = await import("@/lib/db/helpers/kvStore.js");
      expect(json(dump.pricing)).toBe(json(await makeKv("pricing").getAll()));
      expect(json(dump.connections)).toBe(json(await repos.getProviderConnections()));
      expect(json(dump.proxyPools)).toBe(json([await repos.getProxyPoolById(s.pool.id), null]));
      expect(dump.generation).toBe(generation(adapter));
    });
  }
});

// Node on file A, the gateway on its copy B, the same writes on each.
async function twins(driver) {
  const dirA = tempDataDir("gw-twin-a-");
  const dirB = tempDataDir("gw-twin-b-");
  dirs.push(dirA, dirB);
  let { repos, file } = await openRepos(driver, dirA);
  const seeded = await seedConfig(repos);
  // A demotion on model o the probe below makes due.
  await repos.updateProviderConnection(seeded.c1.id, {}, { demote: { model: "o", from: null, to: { count: 3, firstAt: NOW, demotedAt: NOW, nextProbeAt: "2099-01-01T00:00:00.000Z", reason: "403" } } });
  closeRepos(); // checkpoints and closes A
  const fileB = path.join(dirB, "db", "data.sqlite");
  fs.mkdirSync(path.dirname(fileB), { recursive: true });
  fs.copyFileSync(file, fileB);
  ({ repos, file } = await openRepos(driver, dirA));
  return { repos, fileA: file, fileB, dirB, seeded };
}

describe.skipIf(!TOOL)("Go writes what Node writes", () => {
  for (const driver of drivers) {
    it(`on ${driver}`, async () => {
      const { repos, fileA, fileB, dirB, seeded: s } = await twins(driver);
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(NOW));
      const { getAdapter } = await import("@/lib/db/driver.js");
      const a = await getAdapter();
      const goOps = [];
      // What Node's updateProviderConnection returned, per connection op.
      const nodeConn = [];
      const update = async (...args) => { nodeConn.push(await repos.updateProviderConnection(...args)); };

      // ── connection state ──
      const lockSet = {
        modelLock_m1: LATER, modelLimit_m1: true, modelNoHeaders_m1: null, providerReset_m1: null, testStatus: "unavailable",
        lastError: "rate limited", errorCode: 429, lastErrorAt: NOW, backoffLevel: 1, authFailCount: 1, authFailModels: ["m1"],
      };
      await update(s.c1.id, lockSet);
      goOps.push({ op: "connection", id: s.c1.id, set: lockSet });

      const demoteTo = { count: 1, firstAt: NOW, lastCountedAt: NOW, reason: "403 forbidden" };
      await update(s.c1.id, {}, { demote: { model: "m1", from: null, to: demoteTo, data: { lastError: "m1 demoted" }, probeNow: ["o"] }, apiKeyUsed: "upstream-key-1" });
      goOps.push({ op: "connection", id: s.c1.id, demote: { model: "m1", from: null, to: demoteTo, data: { lastError: "m1 demoted" }, probeNow: ["o"] }, apiKeyUsed: "upstream-key-1" });

      // A stale `from` changes nothing.
      await update(s.c1.id, {}, { demote: { model: "m1", from: { count: 0 }, to: { count: 9 } } });
      goOps.push({ op: "connection", id: s.c1.id, demote: { model: "m1", from: { count: 0 }, to: { count: 9 } } });

      const clear = { modelLock_m1: null, providerReset_m1: null, modelLimit_m1: null, modelNoHeaders_m1: null, testStatus: "active", lastError: null, errorCode: null, lastErrorAt: null, backoffLevel: 0, authFailCount: null, authFailModels: null };
      await update(s.c1.id, clear, { liftDemote: "m1", noteServed: true });
      goOps.push({ op: "connection", id: s.c1.id, set: clear, liftDemote: "m1", noteServed: true });

      await update(s.c1.id, { lastUsedAt: NOW, consecutiveUseCount: 2 });
      goOps.push({ op: "connection", id: s.c1.id, set: { lastUsedAt: NOW, consecutiveUseCount: 2 } });

      // A key pasted in since the request: its streak and turn-off are dropped.
      await update(s.c2.id, { authFailCount: 4, lastError: "401" }, { autoDisable: { isActive: false, autoDisabledAt: NOW, autoDisabledReason: "dead" }, apiKeyUsed: "an-older-key" });
      goOps.push({ op: "connection", id: s.c2.id, set: { authFailCount: 4, lastError: "401" }, autoDisable: { at: NOW, reason: "dead" }, apiKeyUsed: "an-older-key" });

      // A dead key turned off while another is on.
      await update(s.c2.id, { authFailCount: 5 }, { autoDisable: { isActive: false, autoDisabledAt: NOW, autoDisabledReason: "401 on m1 (5 times)" }, apiKeyUsed: "upstream-key-2" });
      goOps.push({ op: "connection", id: s.c2.id, set: { authFailCount: 5 }, autoDisable: { at: NOW, reason: "401 on m1 (5 times)" }, apiKeyUsed: "upstream-key-2" });

      // ── learned beta flags (chat.ts's saveDroppedBetas, on the same rows) ──
      const { sanitizeNodeQuirks } = await import("@/shared/utils/nodeQuirks.ts");
      const union = (x, y) => sanitizeNodeQuirks({ droppedBetas: [...(x || []), ...(y || [])] }, { keepEmpty: true }).droppedBetas || [];
      const betas = ["b-2", "a-1", " c-3 ", "not a flag"];
      const conn = await repos.getProviderConnectionById(s.c1.id);
      const psd = conn.providerSpecificData || {};
      await repos.updateProviderConnection(s.c1.id, { providerSpecificData: { ...psd, droppedBetas: union(psd.droppedBetas, betas) } });
      const node = await repos.getProviderNodeById(s.node.id);
      await repos.updateProviderNode(s.node.id, { droppedBetas: union(node.droppedBetas, betas) });
      goOps.push({ op: "droppedBetas", connectionId: s.c1.id, nodeId: s.node.id, betas, ownBaseUrl: false });

      // ── usage ──
      const entries = [
        { timestamp: "2026-03-01T10:00:00.000Z", provider: s.node.id, model: "m1", connectionId: s.c1.id, apiKey: s.key1.key, endpoint: "/v1/messages", tokens: { input_tokens: 1200, output_tokens: 300, cache_read_input_tokens: 800 } },
        { timestamp: "2026-03-01T10:30:00.000Z", provider: s.node.id, model: "m1", connectionId: s.c1.id, apiKey: s.key2.key, endpoint: "/v1/messages", tokens: { input_tokens: 7, output_tokens: 3 } },
        { timestamp: "2026-03-01T10:31:00.000Z", provider: s.node.id, model: "m2", apiKey: s.key2.key, tokens: { prompt_tokens: 11, completion_tokens: 13, cached_tokens: 2 }, status: "error" },
        { timestamp: "2026-03-01T10:32:00.000Z", provider: s.node.id, model: "m1", connectionId: s.c1.id, tokens: { input_tokens: 5, output_tokens: 1 } },
      ];
      const historyBefore = a.get(`SELECT COALESCE(MAX(id), 0) AS id FROM usageHistory`).id;
      for (const e of entries) await repos.saveRequestUsage(structuredClone(e));
      // Node priced them; the gateway gets the price internal/usage would compute.
      const costs = a.all(`SELECT cost FROM usageHistory WHERE id > ? ORDER BY id`, [historyBefore]).map((r) => r.cost);
      expect(costs.some((c) => c > 0)).toBe(true);
      goOps.push({ op: "usage", entries: entries.map((e, i) => ({ ...e, cost: costs[i] })) });

      // ── request details ──
      const { __test__ } = await import("@/lib/db/repos/requestDetailsRepo.js");
      const details = [1, 2, 3, 4].map((i) => ({
        id: `2026-03-01T11:0${i}:00.000Z-abc${i}-m1`, timestamp: `2026-03-01T11:0${i}:00.000Z`, provider: s.node.id, model: "m1",
        connectionId: i === 2 ? null : s.c1.id, status: i === 3 ? "error" : "success", latency: { ttft: 100 * i, total: 900 + i },
        tokens: { input_tokens: i }, request: { model: "m1", stream: true, messages: [{ role: "user", content: `hi ${i}` }] },
        providerRequest: i === 4 ? undefined : { model: "m1-upstream", max_tokens: 1024 }, providerResponse: { status: 200 },
        response: { text: "é ✓   <b>" }, ...(i === 3 ? { errorClass: "upstream_error" } : {}),
      }));
      for (const d of details) await repos.saveRequestDetail(structuredClone(d));
      await __test__.flush();
      goOps.push({ op: "requestDetails", maxRecords: 3, rows: details.map((d) => ({ ...d, connectionId: d.connectionId ?? undefined })) });

      const results = applyGo(fileB, goOps);
      // Each connection write returns what Node's update returned (key order aside:
      // Node's merged object keeps the columns where the row read put them).
      expect(results.filter((_, i) => goOps[i].op === "connection")).toEqual(nodeConn);

      const { DatabaseSync } = await import("node:sqlite");
      const b = new DatabaseSync(fileB);
      try {
        for (const [table, order] of [
          ["providerConnections", "id"], ["providerNodes", "id"], ["apiKeys", "id"], ["usageHistory", "id"],
          ["usageDaily", "dateKey"], ["requestDetails", "id"],
        ]) {
          expect(json(rows({ all: (q) => b.prepare(q).all() }, table, order)), `${table} differs`).toBe(json(rows(a, table, order)));
        }
        for (const key of ["configGeneration", "totalRequestsLifetime"]) {
          expect(b.prepare(`SELECT value FROM _meta WHERE key = ?`).get(key)?.value, `_meta.${key}`)
            .toBe(a.get(`SELECT value FROM _meta WHERE key = ?`, [key])?.value);
        }
      } finally {
        b.close();
      }

      // And Node's repos read the gateway's rows back as their own.
      const fromA = {
        connections: await repos.getProviderConnections(), keys: await repos.getApiKeys(),
        stats: await repos.getUsageStats("all"), details: await repos.getRequestDetails({}),
      };
      vi.useRealTimers();
      const other = await openRepos(driver, dirB);
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(NOW));
      expect(json(await other.repos.getProviderConnections())).toBe(json(fromA.connections));
      expect(json(await other.repos.getApiKeys())).toBe(json(fromA.keys));
      expect(json(await other.repos.getRequestDetails({}))).toBe(json(fromA.details));
      const stats = await other.repos.getUsageStats("all");
      expect(json({ ...stats, pending: undefined })).toBe(json({ ...fromA.stats, pending: undefined }));
    });
  }
});
