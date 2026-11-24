// _meta.configGeneration (src/lib/db/helpers/configGeneration.ts): every
// config write moves it in its own transaction, so the Go gateway knows when
// to reload its snapshot (docs/GO_GATEWAY.md, Config sync). The request path's
// lock and usage writes leave it alone.
//
// Two halves:
//  - WRITE_SITES is every SQL statement in src/ and open-sse/ that writes a
//    config table, by file and enclosing function. A new one fails the first
//    test until it bumps the generation (or is exempt, with its reason) and is
//    listed here.
//  - Every listed site that bumps is run below on each driver, through an
//    adapter that checks each config write has a bump in its transaction.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { closeRepos, driverAvailable, generation, openRepos, tempDataDir } from "../helpers/nodeDb.js";
import { CONFIG_KV_SCOPES } from "@/lib/db/helpers/configGeneration.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CONFIG_TABLES = ["settings", "combos", "providerNodes", "apiKeys", "kv", "providerConnections"];
// SQL keywords in capitals, as every statement in this repo writes them (in
// lower case they'd match prose such as "update combos"); a quoted table
// name, or one named by a template expression (UPDATE ${table}), counts too.
const CONFIG_WRITE = new RegExp(String.raw`\b(?:INSERT(?:\s+OR\s+\w+)?\s+INTO|UPDATE|DELETE\s+FROM|REPLACE\s+INTO)\s+(\$\{[^}]+\}|["\x60[]?(?:${CONFIG_TABLES.join("|")})\b)`, "g");
const KEYWORDS = new Set(["if", "for", "while", "switch", "catch", "function", "return"]);

// file#function → statements. "bumps" sites are run by OPS below; the rest
// say why they need no bump.
const WRITE_SITES = {
  "src/lib/db/repos/settingsRepo.js#updateSettings": [1, "bumps"],
  "src/lib/db/repos/combosRepo.js#createCombo": [1, "bumps"],
  "src/lib/db/repos/combosRepo.js#updateCombo": [1, "bumps"],
  "src/lib/db/repos/combosRepo.js#deleteCombo": [1, "bumps"],
  "src/lib/db/repos/nodesRepo.js#upsert": [1, "bumps"],
  "src/lib/db/repos/nodesRepo.js#deleteProviderNode": [1, "bumps"],
  "src/lib/db/repos/connectionsRepo.js#releaseOwnerIfKeyReplaced": [1, "bumps"],
  "src/lib/db/repos/connectionsRepo.js#upsert": [1, "bumps when connectionConfigChanged"],
  "src/lib/db/repos/connectionsRepo.js#reorderInTx": [1, "bumps"],
  "src/lib/db/repos/connectionsRepo.js#deleteProviderConnectionIf": [1, "bumps"],
  "src/lib/db/repos/connectionsRepo.js#deleteProviderConnectionsByProvider": [1, "bumps"],
  "src/lib/db/repos/apiKeysRepo.js#createApiKey": [1, "bumps"],
  "src/lib/db/repos/apiKeysRepo.js#updateApiKeyInTx": [1, "bumps"],
  "src/lib/db/repos/apiKeysRepo.js#deleteApiKey": [1, "bumps"],
  "src/lib/db/repos/apiKeysRepo.js#addApiKeySpendSync": [1, "exempt: usage spend, written on every request; the gateway reads spend fresh"],
  "src/lib/db/repos/apiKeysRepo.js#reseedApiKeySpend": [1, "exempt: rebuilds spend totals (migration, import, restore), which the gateway reads fresh"],
  "src/lib/db/repos/managementKeysRepo.js#createOwnedApiKey": [1, "bumps"],
  "src/lib/db/repos/managementKeysRepo.js#updateApiKeyAs": [1, "bumps"],
  "src/lib/db/repos/managementKeysRepo.js#deleteRowAsManagementKey": [1, "bumps"],
  "src/lib/db/repos/managementKeysRepo.js#claimRowForManagementKey": [1, "bumps"],
  "src/lib/db/repos/managementKeysRepo.js#setRowOwner": [1, "bumps"],
  "src/lib/db/repos/pricingRepo.js#updatePricing": [1, "bumps"],
  "src/lib/db/repos/pricingRepo.js#resetPricing": [3, "bumps"],
  "src/lib/db/repos/aliasRepo.js#addCustomModel": [2, "bumps"],
  "src/lib/db/helpers/kvStore.js#set": [1, "bumps for CONFIG_KV_SCOPES"],
  "src/lib/db/helpers/kvStore.js#setMany": [1, "bumps for CONFIG_KV_SCOPES"],
  "src/lib/db/helpers/kvStore.js#remove": [1, "bumps for CONFIG_KV_SCOPES"],
  "src/lib/db/helpers/kvStore.js#clear": [1, "bumps for CONFIG_KV_SCOPES"],
  "src/lib/db/index.js#importDb": [14, "bumps"],
  "src/lib/db/repos/disabledModelsRepo.js#disableModels": [1, "exempt: kv scope disabledModels, not in the gateway's snapshot"],
  "src/lib/db/repos/disabledModelsRepo.js#enableModels": [3, "exempt: kv scope disabledModels, not in the gateway's snapshot"],
  "src/lib/hostCredentials.js#saveHostPassword": [2, "exempt: kv scope hostCredentials, not in the gateway's snapshot"],
  "src/lib/db/helpers/hostCredentials.js#migrateLegacyHostPassword": [2, "exempt: kv scope hostCredentials, not in the gateway's snapshot"],
  "src/lib/db/migrate.js#importLegacyMain": [8, "exempt: runs inside the legacy import's transaction, which bumps"],
  "src/lib/db/migrate.js#importLegacyDisabled": [1, "exempt: kv scope disabledModels, not in the gateway's snapshot"],
  "src/lib/db/migrations/003-remove-ide-proxy.js#up": [2, "exempt: a one-time migration at Node's first database use; the gateway's 5 s snapshot TTL picks it up"],
  "src/lib/db/migrations/004-remove-token-saver.js#up": [1, "exempt: a one-time migration at Node's first database use; the gateway's 5 s snapshot TTL picks it up"],
};

function sourceFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, out);
    else if (/\.([mc]?js|jsx|ts|tsx)$/.test(entry.name) && !/\.test\./.test(entry.name)) out.push(full);
  }
  return out;
}

// The function a statement sits in: the nearest declaration above it.
function enclosingFunction(lines, lineIndex) {
  for (let i = lineIndex; i >= 0; i--) {
    const decl = lines[i].match(/^\s*(?:export\s+)?(?:async\s+)?function\s*\*?\s*(\w+)\s*\(/);
    if (decl) return decl[1];
    const method = lines[i].match(/^\s*(?:async\s+)?(\w+)\s*\([^)]*\)\s*\{\s*$/);
    if (method && !KEYWORDS.has(method[1])) return method[1];
  }
  return "(top level)";
}

function scanWriteSites() {
  const sites = {};
  for (const file of [...sourceFiles(path.join(ROOT, "src")), ...sourceFiles(path.join(ROOT, "open-sse"))]) {
    const text = fs.readFileSync(file, "utf8");
    const lines = text.split("\n");
    for (const match of text.matchAll(CONFIG_WRITE)) {
      const line = text.slice(0, match.index).split("\n").length - 1;
      const key = `${path.relative(ROOT, file).split(path.sep).join("/")}#${enclosingFunction(lines, line)}`;
      sites[key] = (sites[key] || 0) + 1;
    }
  }
  return sites;
}

it("every SQL write to a config table is listed, with how it moves the config generation", () => {
  const found = scanWriteSites();
  const listed = Object.fromEntries(Object.entries(WRITE_SITES).map(([k, [n]]) => [k, n]));
  const unlisted = Object.entries(found).filter(([k, n]) => listed[k] !== n);
  const gone = Object.keys(listed).filter((k) => !(k in found));
  expect({ unlisted, gone }, [
    "A write to settings, combos, providerNodes, apiKeys, kv or providerConnections was added, moved or removed.",
    "Run bumpConfigGenerationSync(db) in its transaction (or writeConfig, src/lib/db/helpers/configGeneration.ts),",
    "or say in WRITE_SITES why it needs none; then update WRITE_SITES and cover it in OPS below.",
  ].join(" ")).toEqual({ unlisted: [], gone: [] });
});

// ── Dynamic: each bumping site, on each driver ────────────────────────────

const BUMP = /INSERT INTO _meta\(key, value\) VALUES\('configGeneration'/;
const EXEMPT_SQL = /UPDATE apiKeys SET\s+spentUsd/;

// What a statement writes: "bump", a config table, or null.
function classify(sql, params = []) {
  if (BUMP.test(sql)) return "bump";
  CONFIG_WRITE.lastIndex = 0;
  const m = CONFIG_WRITE.exec(sql);
  CONFIG_WRITE.lastIndex = 0;
  if (!m || EXEMPT_SQL.test(sql)) return null;
  const table = m[1].replace(/["`[\]]/g, "").toLowerCase();
  // Lock and usage writes to providerConnections are checked per op instead.
  if (table === "providerconnections" || table.startsWith("${")) return null;
  if (table === "kv") {
    const literal = sql.match(/scope = '(\w+)'|VALUES\('(\w+)'/);
    const scope = literal ? literal[1] || literal[2] : params[0];
    return CONFIG_KV_SCOPES.has(scope) ? "kv" : null;
  }
  return table;
}

// An adapter that records, per outermost transaction, its config writes and
// whether it bumped. A config write, or a bump, outside a transaction is a
// violation: the bump must commit with the write.
function instrument(adapter, violations, seen) {
  let depth = 0;
  let tx = null;
  const note = (sql, params) => {
    const kind = classify(sql, params);
    if (!kind) return;
    if (depth === 0) violations.push(`outside a transaction: ${sql.slice(0, 80)}`);
    else if (kind === "bump") tx.bumped = true;
    else tx.writes.push(sql.slice(0, 80));
  };
  return {
    ...adapter,
    run(sql, params) { note(sql, params); return adapter.run(sql, params); },
    // A write with RETURNING goes through get or all.
    get(sql, params) { note(sql, params); return adapter.get(sql, params); },
    all(sql, params) { note(sql, params); return adapter.all(sql, params); },
    exec(sql) { note(sql); return adapter.exec(sql); },
    transaction(fn) {
      if (depth === 0) {
        tx = { writes: [], bumped: false };
        seen.transactions++;
      }
      depth++;
      try {
        return adapter.transaction(fn);
      } finally {
        depth--;
        if (depth === 0) {
          if (tx.writes.length && !tx.bumped) violations.push(`no bump in the transaction of: ${tx.writes.join(" | ")}`);
          tx = null;
        }
      }
    },
  };
}

const now = () => new Date().toISOString();

// Each op: the sites it covers, whether the generation must move.
const OPS = [
  { name: "updateSettings", covers: ["settingsRepo.js#updateSettings"], bump: true, run: ({ repos }) => repos.updateSettings({ stickyRoundRobinLimit: 4 }) },
  { name: "createCombo", covers: ["combosRepo.js#createCombo"], bump: true, run: async (c) => { c.combo = await c.repos.createCombo({ name: "c1", models: ["a/b"] }); } },
  { name: "updateCombo", covers: ["combosRepo.js#updateCombo"], bump: true, run: (c) => c.repos.updateCombo(c.combo.id, { models: ["a/c"] }) },
  { name: "deleteCombo", covers: ["combosRepo.js#deleteCombo"], bump: true, run: (c) => c.repos.deleteCombo(c.combo.id) },
  { name: "createProviderNode", covers: ["nodesRepo.js#upsert"], bump: true, run: async (c) => { c.node = await c.repos.createProviderNode({ type: "openai-compatible", name: "N", prefix: "n", baseUrl: "http://x" }); } },
  { name: "updateProviderNode", covers: ["nodesRepo.js#upsert"], bump: true, run: (c) => c.repos.updateProviderNode(c.node.id, { droppedBetas: ["x"] }) },
  { name: "deleteProviderNode", covers: ["nodesRepo.js#deleteProviderNode"], bump: true, run: (c) => c.repos.deleteProviderNode(c.node.id) },
  {
    name: "createProviderConnection", covers: ["connectionsRepo.js#upsert"], bump: true,
    run: async (c) => {
      c.conn = await c.repos.createProviderConnection({ provider: "p", authType: "apikey", name: "k1", apiKey: "secret-1" });
      c.conn2 = await c.repos.createProviderConnection({ provider: "p", authType: "apikey", name: "k2", apiKey: "secret-2" });
    },
  },
  {
    name: "a lock write", covers: [], bump: false,
    run: (c) => c.repos.updateProviderConnection(c.conn.id, {
      modelLock_m: now(), modelLimit_m: true, providerReset_m: null, testStatus: "unavailable", lastError: "429", errorCode: 429, lastErrorAt: now(), backoffLevel: 1,
      authFailCount: 1, authFailModels: ["m"],
    }),
  },
  {
    name: "a demotion", covers: [], bump: false,
    run: (c) => c.repos.updateProviderConnection(c.conn.id, {}, { demote: { model: "m", from: null, to: { count: 1, firstAt: now() }, data: { lastError: "403" } }, apiKeyUsed: "secret-1" }),
  },
  {
    name: "a success clearing locks", covers: [], bump: false,
    run: (c) => c.repos.updateProviderConnection(c.conn.id, { modelLock_m: null, modelLimit_m: null, testStatus: "active", lastError: null, errorCode: null, backoffLevel: 0 }, { liftDemote: "m", noteServed: true }),
  },
  { name: "round-robin stickiness", covers: [], bump: false, run: (c) => c.repos.updateProviderConnection(c.conn.id, { lastUsedAt: now(), consecutiveUseCount: 2 }) },
  { name: "a token refresh", covers: [], bump: false, run: (c) => c.repos.updateProviderConnection(c.conn.id, { accessToken: "a2", expiresAt: now(), lastRefreshAt: now() }) },
  { name: "a dashboard rename", covers: ["connectionsRepo.js#upsert"], bump: true, run: (c) => c.repos.updateProviderConnection(c.conn.id, { name: "renamed" }) },
  { name: "a proxy change", covers: ["connectionsRepo.js#upsert"], bump: true, run: (c) => c.repos.updateProviderConnection(c.conn.id, { providerSpecificData: { proxyPoolId: "pool" } }) },
  { name: "a priority change", covers: ["connectionsRepo.js#reorderInTx"], bump: true, run: (c) => c.repos.updateProviderConnection(c.conn.id, { priority: 2 }) },
  {
    name: "auto-disable", covers: ["connectionsRepo.js#upsert"], bump: true,
    run: async (c) => {
      const saved = await c.repos.updateProviderConnection(c.conn2.id, { authFailCount: 3 }, { autoDisable: { isActive: false, autoDisabledAt: now(), autoDisabledReason: "dead" }, apiKeyUsed: "secret-2" });
      expect(saved.isActive).toBe(false);
    },
  },
  {
    name: "a key replaced on a management key's connection", covers: ["managementKeysRepo.js#setRowOwner", "connectionsRepo.js#releaseOwnerIfKeyReplaced"], bump: true,
    run: async (c) => {
      await c.repos.setRowOwner("providerKey", c.conn.id, "mk-1");
      await c.repos.updateProviderConnection(c.conn.id, { apiKey: "secret-3" });
    },
  },
  { name: "reorderProviderConnections", covers: ["connectionsRepo.js#reorderInTx"], bump: true, run: (c) => c.repos.reorderProviderConnections("p") },
  {
    name: "cleanupProviderConnections", covers: ["connectionsRepo.js#upsert"], bump: true,
    run: async (c) => { expect(await c.repos.cleanupProviderConnections()).toBeGreaterThan(0); },
  },
  { name: "deleteProviderConnection", covers: ["connectionsRepo.js#deleteProviderConnectionIf"], bump: true, run: (c) => c.repos.deleteProviderConnection(c.conn2.id) },
  { name: "deleteProviderConnectionsByProvider", covers: ["connectionsRepo.js#deleteProviderConnectionsByProvider"], bump: true, run: (c) => c.repos.deleteProviderConnectionsByProvider("p") },
  { name: "createApiKey", covers: ["apiKeysRepo.js#createApiKey"], bump: true, run: async (c) => { c.key = await c.repos.createApiKey("k", "machine-1"); } },
  { name: "updateApiKey", covers: ["apiKeysRepo.js#updateApiKeyInTx"], bump: true, run: (c) => c.repos.updateApiKey(c.key.id, { budgetUsd: 5 }) },
  {
    name: "usage on a key", covers: [], bump: false,
    run: (c) => c.repos.saveRequestUsage({ provider: "p", model: "m", apiKey: c.key.key, tokens: { input_tokens: 1, output_tokens: 1 } }),
  },
  { name: "deleteApiKey", covers: ["apiKeysRepo.js#deleteApiKey"], bump: true, run: (c) => c.repos.deleteApiKey(c.key.id) },
  {
    name: "createOwnedApiKey", covers: ["managementKeysRepo.js#createOwnedApiKey"], bump: true,
    run: async (c) => {
      ({ managementKey: c.mk } = await c.repos.createScopedManagementKey({ name: "mk", scopes: {} }));
      c.owned = await c.repos.createOwnedApiKey({ name: "o", machineId: "machine-1", limits: {}, ownerId: c.mk.id });
      expect(c.owned).toBeTruthy();
    },
  },
  { name: "updateApiKeyAs", covers: ["managementKeysRepo.js#updateApiKeyAs"], bump: true, run: (c) => c.repos.updateApiKeyAs(c.owned.id, { isActive: false }, "dashboard") },
  { name: "claimRowForManagementKey", covers: ["managementKeysRepo.js#claimRowForManagementKey"], bump: true, run: (c) => c.repos.claimRowForManagementKey("clientKey", c.owned.id, c.mk.id) },
  { name: "deleteRowAsManagementKey", covers: ["managementKeysRepo.js#deleteRowAsManagementKey"], bump: true, run: (c) => c.repos.deleteRowAsManagementKey("clientKey", c.owned.id, c.mk.id) },
  { name: "updatePricing", covers: ["pricingRepo.js#updatePricing"], bump: true, run: (c) => c.repos.updatePricing({ p: { m: { input: 1 }, m2: { input: 2 } } }) },
  { name: "resetPricing (one model)", covers: ["pricingRepo.js#resetPricing"], bump: true, run: (c) => c.repos.resetPricing("p", "m") },
  { name: "resetPricing (provider)", covers: ["pricingRepo.js#resetPricing"], bump: true, run: (c) => c.repos.resetPricing("p") },
  { name: "resetAllPricing", covers: ["kvStore.js#clear"], bump: true, run: (c) => c.repos.resetAllPricing() },
  { name: "setModelAlias", covers: ["kvStore.js#set"], bump: true, run: (c) => c.repos.setModelAlias("fast", "p/m") },
  { name: "deleteModelAlias", covers: ["kvStore.js#remove"], bump: true, run: (c) => c.repos.deleteModelAlias("fast") },
  { name: "addCustomModel", covers: ["aliasRepo.js#addCustomModel"], bump: true, run: (c) => c.repos.addCustomModel({ providerAlias: "p", id: "m", name: "M" }) },
  { name: "addCustomModel (again)", covers: ["aliasRepo.js#addCustomModel"], bump: true, run: (c) => c.repos.addCustomModel({ providerAlias: "p", id: "m", name: "M2" }) },
  { name: "deleteCustomModel", covers: ["kvStore.js#remove"], bump: true, run: (c) => c.repos.deleteCustomModel({ providerAlias: "p", id: "m" }) },
  {
    name: "kv setMany (pricing)", covers: ["kvStore.js#setMany"], bump: true,
    run: async () => { const { makeKv } = await import("@/lib/db/helpers/kvStore.js"); await makeKv("pricing").setMany({ q: { m: { input: 3 } } }); },
  },
  { name: "quota notification state", covers: [], bump: false, run: (c) => c.repos.setQuotaNotificationState("conn", { at: 1 }) },
  { name: "disabled models", covers: [], bump: false, run: (c) => c.repos.disableModels("p", ["m"]) },
  { name: "importDb", covers: ["index.js#importDb"], bump: true, run: async (c) => { await c.repos.importDb(await c.repos.exportDb()); } },
];

it("OPS cover every site that bumps", () => {
  const covered = new Set(OPS.flatMap((op) => op.covers));
  const bumping = Object.entries(WRITE_SITES).filter(([, [, how]]) => how.startsWith("bumps")).map(([k]) => k.replace(/^.*\//, ""));
  expect(bumping.filter((k) => !covered.has(k))).toEqual([]);
});

const dirs = [];
afterAll(() => {
  closeRepos();
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

for (const driver of ["sql.js", "node:sqlite", "better-sqlite3"]) {
  const available = await driverAvailable(driver);
  describe.skipIf(!available)(`config generation on ${driver}`, () => {
    it("moves with every config write, in its transaction, and never with lock or usage writes", async () => {
      const dir = tempDataDir("config-generation-");
      dirs.push(dir);
      const violations = [];
      const seen = { transactions: 0 };
      const ctx = await openRepos(driver, dir, { wrap: (a) => instrument(a, violations, seen) });
      expect(ctx.adapter.driver).toBe(driver);
      // The driver is recorded for the gateway's guard.
      expect(ctx.adapter.get(`SELECT value FROM _meta WHERE key = 'dbDriver'`)?.value).toBe(driver);
      const results = [];
      for (const op of OPS) {
        const before = generation(ctx.adapter);
        await op.run(ctx);
        const moved = generation(ctx.adapter) > before;
        results.push([op.name, moved]);
      }
      expect(results).toEqual(OPS.map((op) => [op.name, op.bump]));
      expect(violations).toEqual([]);
      // The repos ran through the checking adapter.
      expect(seen.transactions).toBeGreaterThan(OPS.length / 2);
    });
  });
}
