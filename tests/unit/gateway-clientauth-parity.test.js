// Golden fixtures for the Go gateway's client checks (gateway/internal/clientauth,
// docs/GO_GATEWAY.md "Parity testing").
//
// Each case is a POST /v1/messages from a client on this machine or a remote
// one, with its key in one of the places Node reads it from. It goes through
// Node's real public-LLM gate (dashboardGuard.js's proxy) and then chat.ts's
// checks as it runs them (requireApiKey, missingModel, checkApiKeyLimits,
// keyHasBudget) over one synthetic key table inserted as rows of a real Node
// database and read by Node's repos. The fixture holds those rows; the Go
// test loads them into its own SQLite file and reads them through the
// gateway's readers (settings are set per case on both sides). The Go
// port must let a request
// through exactly when Node does; where it is stricter on purpose, the case
// says why ("conservative"), and the request goes to Node.
//
// Without CLIENTAUTH_RECORD this checks that Node still gives the committed
// answers. With CLIENTAUTH_RECORD=1 it writes them.
import { describe, it, expect, vi, afterAll } from "vitest";
import { createRequire } from "node:module";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { closeRepos, openRepos, tempDataDir } from "../helpers/nodeDb.js";

const PEER_TOKEN = "peer-token-fixture-0000000000000000";
const db = {
  // apiKeys rows, as stored.
  keys: [
    { key: "sk-active", isActive: 1 },
    { key: "sk-inactive", isActive: 0 },
    { key: "sk-expired", isActive: 1, expiresAt: "2001-01-01T00:00:00.000Z" },
    { key: "sk-future", isActive: 1, expiresAt: "2999-01-01T00:00:00.000Z" },
    { key: "sk-spent", isActive: 1, budgetUsd: 5, spentUsd: 5 },
    { key: "sk-budget", isActive: 1, budgetUsd: 5, spentUsd: 1.25 },
    { key: "sk-reset", isActive: 1, budgetUsd: 5, spentUsd: 9, spendOffsetUsd: 6 },
    { key: "sk-zero-budget", isActive: 1, budgetUsd: 0 },
    { key: "sk-allow-combo", isActive: 1, allowedModels: JSON.stringify(["main"]) },
    { key: "sk-allow-members", isActive: 1, allowedModels: JSON.stringify(["hot/model-a", "hot/model-b"]) },
    { key: "sk-allow-partial", isActive: 1, allowedModels: JSON.stringify(["hot/model-a"]) },
    { key: "sk-allow-bare", isActive: 1, allowedModels: JSON.stringify(["model-a", "model-b"]) },
    { key: "sk-allow-alias", isActive: 1, allowedModels: JSON.stringify(["fast"]) },
    { key: "sk-allow-alias-target", isActive: 1, allowedModels: JSON.stringify(["hot/model-a"]) },
    { key: "sk-allow-ctx", isActive: 1, allowedModels: JSON.stringify(["main[1m]"]) },
    { key: "sk-allow-nested", isActive: 1, allowedModels: JSON.stringify(["nested"]) },
    { key: "sk-allow-nested-members", isActive: 1, allowedModels: JSON.stringify(["main", "hot/model-d"]) },
    { key: "sk-allow-case", isActive: 1, allowedModels: JSON.stringify(["MAIN"]) },
    { key: "sk-allow-upper-members", isActive: 1, allowedModels: JSON.stringify(["HOT/Model-A", "hot/MODEL-B[1m]"]) },
    { key: "sk-allow-deep", isActive: 1, allowedModels: JSON.stringify(["hot/model-z"]) },
    { key: "sk-allow-fusion", isActive: 1, allowedModels: JSON.stringify(["hot/model-a", "hot/judge"]) },
    { key: "sk-allow-unicode", isActive: 1, allowedModels: JSON.stringify(["mäin"]) },
    { key: "sk-allow-empty", isActive: 1, allowedModels: JSON.stringify([]) },
    { key: "sk-budget-allow", isActive: 1, budgetUsd: 10, spentUsd: 2, allowedModels: JSON.stringify(["main"]) },
    { key: " sk-padded", isActive: 1 },
    { key: "sk-disabled-by-owner", isActive: 1, disabledBy: "dashboard" },
    { key: "sk-allow-object-alias", isActive: 1, allowedModels: JSON.stringify(["hot/model-b"]) },
    { key: "sk-allow-object-alias-name", isActive: 1, allowedModels: JSON.stringify(["objectAlias"]) },
    { key: "sk-allow-suffix-member", isActive: 1, allowedModels: JSON.stringify(["hot/model-c(high)"]) },
    { key: "sk-allowlist-not-array", isActive: 1, allowedModels: JSON.stringify({ main: true }) },
    { key: "sk-allowlist-non-strings", isActive: 1, allowedModels: JSON.stringify([7, null]) },
    // Text SQLite can't read as a number, which Number() reads as 16.
    { key: "sk-text-spend", isActive: 1, budgetUsd: 5, spentUsd: "0x10" },
  ],
  combos: {
    main: ["hot/model-a", "hot/model-b"],
    nested: ["main", "hot/model-d"],
    d1: ["d2"], d2: ["d3"], d3: ["d4"], d4: ["d5"], d5: ["hot/model-z"],
    loop: ["loop"],
    fusey: ["hot/model-a"],
    suffixed: ["hot/model-c(high)"],
  },
  aliases: { fast: "hot/model-a", objectAlias: { provider: "hot", model: "model-b" } },
  comboStrategies: { fusey: { fallbackStrategy: "fusion", judgeModel: " hot/judge " } },
};

// Only what isn't the database is mocked: Next's response helpers, the CLI
// token (which needs a machine id), the dashboard session and OIDC.
vi.mock("next/server", () => ({
  NextResponse: {
    next: () => ({ next: true }),
    json: (body, init) => ({ status: init?.status || 200, body }),
    redirect: (url) => ({ status: 307, url }),
  },
}));
vi.mock("@/lib/auth/cliToken.js", () => ({ CLI_TOKEN_HEADER: "x-9r-cli-token", isValidCliToken: async () => false }));
vi.mock("@/lib/auth/dashboardSession", () => ({ verifyDashboardAuthToken: async () => false, getDashboardAuthSession: async () => null }));
vi.mock("@/lib/auth/oidc", () => ({ isOidcConfigured: () => false }));

// The key table, combos and aliases in a real Node database, read by the
// real repos (validateApiKey, getApiKeyPolicy, getComboByName, getModelAliases).
const NOW = "2026-01-01T00:00:00.000Z";
const dir = tempDataDir("gateway-clientauth-");
const { adapter, repos } = await openRepos("sql.js", dir);
for (const row of db.keys) {
  const full = { id: `id-${row.key.trim()}`, name: row.key.trim(), createdAt: NOW, ...row };
  const cols = Object.keys(full);
  adapter.run(`INSERT INTO apiKeys(${cols.join(", ")}) VALUES(${cols.map(() => "?").join(", ")})`, cols.map((c) => full[c]));
}
for (const [name, models] of Object.entries(db.combos)) {
  adapter.run(`INSERT INTO combos(id, name, kind, models, createdAt, updatedAt) VALUES(?, ?, NULL, ?, ?, ?)`, [`combo-${name}`, name, JSON.stringify(models), NOW, NOW]);
}
for (const [key, value] of Object.entries(db.aliases)) {
  adapter.run(`INSERT INTO kv(scope, key, value) VALUES('modelAliases', ?, ?)`, [key, JSON.stringify(value)]);
}
afterAll(() => {
  closeRepos();
  rmSync(dir, { recursive: true, force: true });
});

const { proxy } = await import("../../src/dashboardGuard.js");
const { isValidApiKey, extractApiKey } = await import("../../src/sse/services/auth.js");
const { checkApiKeyLimits, keyHasBudget } = await import("../../src/sse/services/keyLimits.js");
const { missingModel } = await import("../../src/sse/utils/requestBody.js");
const { stripModelContextMarker } = await import("../../open-sse/utils/modelMarkers.js");

const require = createRequire(import.meta.url);
const SERVER_PATH = require.resolve("../../custom-server.js");
const originalCreateServer = http.createServer;
const { __test__: server } = require(SERVER_PATH);
http.createServer = originalCreateServer;

const FIXTURE_FILE = fileURLToPath(new URL("../../gateway/internal/clientauth/testdata/cases.json", import.meta.url));
const RECORD = process.env.CLIENTAUTH_RECORD === "1";

const LOCAL = { socketIp: "127.0.0.1", headers: { host: "localhost:20128" } };
const REMOTE = { socketIp: "203.0.113.7", headers: { host: "router.example.test" } };

// One case: who sends it, its headers, the query, the model, the settings.
// requireApiKey is the stored value, whatever its type. conservative is the
// words the Go decline must contain when Node serves the case and Go, on
// purpose, sends it to Node.
function build() {
  const cases = [];
  const add = (name, { peer = LOCAL, headers = {}, query = "", model = "main", requireApiKey = true, comboStrategy = "fallback", conservative = "" } = {}) =>
    cases.push({ name, socketIp: peer.socketIp, headers: { ...peer.headers, ...headers }, query, model, requireApiKey, comboStrategy, conservative });

  for (const row of db.keys) {
    for (const [where, peer] of [["local", LOCAL], ["remote", REMOTE]]) {
      for (const requireApiKey of [true, false]) {
        const conservative = /unicode/.test(row.key) ? "not printable ASCII" : "";
        add(`${row.key.trim()} ${where} requireApiKey=${requireApiKey}`, { peer, headers: { "x-api-key": row.key }, requireApiKey, conservative });
      }
    }
  }
  // requireApiKey is read by truthiness.
  for (const requireApiKey of [1, "yes", 0, "", null]) {
    add(`no key local requireApiKey=${JSON.stringify(requireApiKey)}`, { requireApiKey });
  }
  // A global fusion strategy makes every combo's judge a member.
  add("global fusion, no allowlist", { peer: REMOTE, headers: { "x-api-key": "sk-active" }, comboStrategy: "fusion" });
  add("global fusion, allowlist walks the combo", { peer: REMOTE, headers: { "x-api-key": "sk-allow-members" }, comboStrategy: "fusion", conservative: "fusion" });
  add("global fusion, combo named", { peer: REMOTE, headers: { "x-api-key": "sk-allow-combo" }, comboStrategy: "fusion", conservative: "fusion" });
  for (const requireApiKey of [true, false]) {
    add(`no key local requireApiKey=${requireApiKey}`, { requireApiKey });
    add(`no key remote requireApiKey=${requireApiKey}`, { peer: REMOTE, requireApiKey });
    add(`unknown key local requireApiKey=${requireApiKey}`, { headers: { "x-api-key": "sk-unknown" }, requireApiKey });
    add(`unknown key remote requireApiKey=${requireApiKey}`, { peer: REMOTE, headers: { "x-api-key": "sk-unknown" }, requireApiKey });
  }
  // Where the key comes from.
  add("bearer", { peer: REMOTE, headers: { authorization: "Bearer sk-active" } });
  add("bearer lowercase scheme", { peer: REMOTE, headers: { authorization: "bearer sk-active" } });
  add("bearer before x-api-key", { peer: REMOTE, headers: { authorization: "Bearer sk-inactive", "x-api-key": "sk-active" } });
  add("non-bearer authorization falls to x-api-key", { peer: REMOTE, headers: { authorization: "Basic abc", "x-api-key": "sk-active" } });
  add("empty bearer hides x-api-key", { peer: REMOTE, headers: { authorization: "Bearer ", "x-api-key": "sk-active" } });
  add("x-goog-api-key", { peer: REMOTE, headers: { "x-goog-api-key": "sk-active" } });
  add("x-api-key before x-goog-api-key", { peer: REMOTE, headers: { "x-api-key": "sk-inactive", "x-goog-api-key": "sk-active" } });
  add("query key", { peer: REMOTE, query: "key=sk-active", conservative: "query string" });
  add("query without a key", { peer: REMOTE, query: "beta=true", headers: { "x-api-key": "sk-active" } });
  add("query and no header, local, no key needed", { query: "beta=true", requireApiKey: false, conservative: "query string" });
  add("padded key", { peer: REMOTE, headers: { authorization: "Bearer  sk-padded" } });
  // Management keys, however padded.
  add("management key local", { headers: { "x-api-key": "10r-mgmt-abc" }, requireApiKey: false });
  add("management key in bearer", { headers: { authorization: "Bearer 10r-mgmt-abc" }, requireApiKey: false });
  add("management key padded", { headers: { authorization: "Bearer  x10r-mgmt-abc" }, requireApiKey: false });
  // Who is on this machine.
  add("local with a forwarding header", { headers: { "x-forwarded-for": "198.51.100.4" }, requireApiKey: false });
  add("local with a loopback origin", { headers: { origin: "http://localhost:3000" }, requireApiKey: false, conservative: "not on this machine" });
  add("local with a loopback origin and a key", { headers: { origin: "http://localhost:3000", "x-api-key": "sk-active" }, requireApiKey: false });
  add("local with a foreign origin", { headers: { origin: "https://other.example.test" }, requireApiKey: false });
  add("local with a bad origin", { headers: { origin: "null" }, requireApiKey: false });
  add("local cross-site fetch", { headers: { "sec-fetch-site": "cross-site" }, requireApiKey: false });
  add("local same-origin fetch", { headers: { "sec-fetch-site": "same-origin" }, requireApiKey: false });
  add("local typed navigation", { headers: { "sec-fetch-site": "none" }, requireApiKey: false });
  add("loopback socket, public Host", { peer: { socketIp: "127.0.0.1", headers: { host: "router.example.test" } }, requireApiKey: false });
  add("loopback socket, no Host", { peer: { socketIp: "127.0.0.1", headers: {} }, requireApiKey: false });
  add("mapped loopback socket", { peer: { socketIp: "::ffff:127.0.0.1", headers: { host: "127.0.0.1:20128" } }, requireApiKey: false });
  // The model.
  for (const [model, key] of [
    ["", "sk-active"], ["   ", "sk-active"], ["main[1m]", "sk-allow-combo"], ["main[1M]", "sk-allow-members"], [" main ", "sk-allow-combo"],
    ["fast", "sk-allow-alias"], ["fast", "sk-allow-alias-target"], ["fast", "sk-allow-members"], ["nested", "sk-allow-nested"],
    ["nested", "sk-allow-nested-members"], ["nested", "sk-allow-members"], ["d1", "sk-allow-deep"], ["d1", "sk-allow-members"],
    ["loop", "sk-allow-members"], ["fusey", "sk-allow-fusion"], ["fusey", "sk-allow-members"], ["hot/model-a", "sk-allow-bare"],
    ["other/model-a", "sk-allow-bare"], ["hot/x/model-a", "sk-allow-bare"], ["HOT/MODEL-A", "sk-allow-members"], ["main", "sk-allow-upper-members"],
    ["cc/claude-x", "sk-allow-members"], ["main", "sk-budget-allow"], ["nested", "sk-budget-allow"],
    ["objectAlias", "sk-allow-object-alias"], ["objectAlias", "sk-allow-object-alias-name"], ["suffixed", "sk-allow-suffix-member"],
    ["suffixed", "sk-allow-members"], ["hot/model-c(high)", "sk-allow-suffix-member"],
  ]) {
    const conservative = /^fusey$/.test(model) ? "fusion" : "";
    add(`model ${JSON.stringify(model)} with ${key}`, { peer: REMOTE, headers: { "x-api-key": key }, model, conservative });
  }
  return cases;
}

function guardRequest(c) {
  const local = server.isOnThisMachine(c.headers, c.socketIp);
  const stamped = new Headers(c.headers);
  // custom-server.js's stamps, proven by its peer token.
  stamped.set("x-9r-peer-token", PEER_TOKEN);
  stamped.set("x-9r-real-ip", server.clientIpFor ? server.clientIpFor(c.headers, c.socketIp) : c.socketIp);
  if (!local) stamped.set("x-9r-via-proxy", "1");
  const url = `http://localhost/v1/messages${c.query ? `?${c.query}` : ""}`;
  return {
    nextUrl: { pathname: "/v1/messages", searchParams: new URL(url).searchParams },
    headers: stamped,
    cookies: { get: () => undefined },
    url,
    method: "POST",
  };
}

// The request through Node: the gate, then chat.ts's checks in its order.
async function runNode(c) {
  await repos.updateSettings({ requireApiKey: c.requireApiKey, comboStrategy: c.comboStrategy, comboStrategies: db.comboStrategies });
  const request = guardRequest(c);
  const gate = await proxy(request);
  if (!gate?.next) return { gate: gate.status };
  const apiKey = extractApiKey(request);
  if ((await repos.getSettings()).requireApiKey) {
    if (!apiKey) return { gate: "next", chat: 401 };
    if (!(await isValidApiKey(apiKey))) return { gate: "next", chat: 401 };
  }
  const { model: modelStr } = stripModelContextMarker(c.model);
  if (missingModel(modelStr)) return { gate: "next", chat: 400 };
  const denied = await checkApiKeyLimits(apiKey, { model: modelStr, format: "claude" });
  if (denied) return { gate: "next", chat: denied.status };
  return { gate: "next", chat: "pass", key: apiKey ?? null, hasBudget: await keyHasBudget(apiKey) };
}

describe("client check fixtures for the Go gateway", () => {
  it("answers every case as the committed fixture says", async () => {
    process.env.NINEROUTER_PEER_TOKEN = PEER_TOKEN;
    const cases = build();
    expect(cases.length).toBeGreaterThanOrEqual(150);
    for (const c of cases) c.node = await runNode(c);
    const passes = cases.filter((c) => c.node.chat === "pass").length;
    expect(passes).toBeGreaterThan(30);
    expect(cases.length - passes).toBeGreaterThan(30);
    // The rows as Node stored them, for the Go test to load.
    const rows = {
      apiKeys: adapter.all(`SELECT * FROM apiKeys ORDER BY rowid`),
      combos: adapter.all(`SELECT * FROM combos ORDER BY rowid`),
      kv: adapter.all(`SELECT * FROM kv WHERE scope = 'modelAliases' ORDER BY rowid`),
    };
    const text = JSON.stringify({ rows, comboStrategies: db.comboStrategies, cases }, null, 1) + "\n";
    if (RECORD) writeFileSync(FIXTURE_FILE, text);
    expect(readFileSync(FIXTURE_FILE, "utf8"), "Node's client checks changed: regenerate with CLIENTAUTH_RECORD=1 and update gateway/internal/clientauth").toBe(text);
  });
});
