// Golden fixtures for the Go gateway's model and combo resolution
// (gateway/internal/combo, docs/GO_GATEWAY.md "Phase 2c").
//
// One synthetic database (custom nodes with prefixes, combos nested, empty and
// with non-string members, aliases of every stored shape) is inserted as rows
// of a real Node database, and each model id goes through Node's real
// getModelInfo and getComboModels (src/sse/services/model.js), which read them
// through Node's repos. The fixture holds the rows, which the Go test loads
// into its own SQLite file and reads through the gateway's snapshot, and the
// answers it must give.
//
// Without COMBO_RECORD this checks that Node still gives the committed answers
// and table export, so a Node change the Go port would miss fails here too.
// With COMBO_RECORD=1 it writes them.
import { describe, it, expect, afterAll } from "vitest";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { closeRepos, openRepos, tempDataDir } from "../helpers/nodeDb.js";

const config = {
  // Inserted in this order. The two "hot" nodes are out of id order, so the
  // first match is the first row, not the smaller id.
  nodes: [
    { id: "openai-compatible-chat-b002", type: "openai-compatible", prefix: "hot" },
    { id: "openai-compatible-chat-a001", type: "openai-compatible", prefix: "hot" },
    { id: "openai-compatible-responses-0003", type: "openai-compatible", prefix: "resp" },
    { id: "anthropic-compatible-0004", type: "anthropic-compatible", prefix: "anth" },
    { id: "anthropic-compatible-0005", type: "anthropic-compatible", prefix: "both" },
    { id: "openai-compatible-chat-0006", type: "openai-compatible", prefix: "both" },
    { id: "custom-embedding-0007", type: "custom-embedding", prefix: "emb" },
    // A user prefix spelled like a built-in provider: never matched.
    { id: "openai-compatible-chat-0008", type: "openai-compatible", prefix: "openai" },
    { id: "openai-compatible-chat-0009", type: "openai-compatible", prefix: "xmtp" },
    { id: "openai-compatible-chat-0010", type: "openai-compatible", prefix: "" },
    { id: "openai-compatible-chat-0011", type: "openai-compatible", prefix: 7 },
    { id: "openai-compatible-chat-0012", type: "openai-compatible" },
  ],
  combos: {
    main: ["hot/model-a", "hot/model-b(high)", "anth/model-c"],
    nested: ["main", "hot/model-d"],
    self: ["self", "hot/model-a"],
    empty: [],
    mixed: ["hot/model-a", 7, null],
    "with[1m]": ["hot/model-a"],
    "grok-build": ["hot/model-e"],
  },
  // A combo whose models column isn't an array: rowToCombo's value, whatever it is.
  rawCombos: { stringModels: "\"hot/model-a\"", brokenModels: "{not json" },
  aliases: {
    fast: "hot/model-a",
    objectAlias: { provider: "hot", model: "model-b" },
    objectBuiltin: { provider: "cc", model: "claude-x" },
    halfObject: { provider: "hot" },
    noSlash: "model-only",
    falsy: "",
    numberAlias: 5,
    builtinTarget: "gcli/whatever",
    main: "hot/shadowed-by-combo",
  },
};

const NOW = "2026-01-01T00:00:00.000Z";
const dir = tempDataDir("gateway-combo-");
const { adapter } = await openRepos("sql.js", dir);
for (const { id, type, ...data } of config.nodes) {
  adapter.run(`INSERT INTO providerNodes(id, type, name, data, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?)`, [id, type, id, JSON.stringify(data), NOW, NOW]);
}
const comboRows = [...Object.entries(config.combos).map(([n, m]) => [n, JSON.stringify(m)]), ...Object.entries(config.rawCombos)];
for (const [name, models] of comboRows) {
  adapter.run(`INSERT INTO combos(id, name, kind, models, createdAt, updatedAt) VALUES(?, ?, NULL, ?, ?, ?)`, [`combo-${name}`, name, models, NOW, NOW]);
}
for (const [key, value] of Object.entries(config.aliases)) {
  adapter.run(`INSERT INTO kv(scope, key, value) VALUES('modelAliases', ?, ?)`, [key, JSON.stringify(value)]);
}

// After openRepos, so they share its database.
const coreModel = await import("../../open-sse/services/model.js");
const appModel = await import("../../src/sse/services/model.js");
const { MAX_COMBO_DEPTH } = await import("../../open-sse/config/runtimeConfig.js");
const { SEARCH_TOOL_TYPES } = await import("../../open-sse/config/appConstants.js");
const { CLAUDE_BLOCK } = await import("../../open-sse/translator/schema/blocks.js");

afterAll(() => {
  closeRepos();
  rmSync(dir, { recursive: true, force: true });
});

const GATEWAY_DIR = fileURLToPath(new URL("../../gateway/internal/combo/", import.meta.url));
const TABLES_FILE = `${GATEWAY_DIR}tables.json`;
const FIXTURE_FILE = `${GATEWAY_DIR}testdata/resolve.json`;
const RECORD = process.env.COMBO_RECORD === "1";

function tablesText() {
  for (const [re] of coreModel.MODEL_PREFIX_PROVIDERS) expect(re.flags, "the Go port compiles the bare source").toBe("");
  for (const v of Object.values(coreModel.BUILTIN_MODEL_ALIASES)) expect(typeof v).toBe("string");
  const tables = {
    aliasToProviderId: coreModel.ALIAS_TO_PROVIDER_ID,
    localProviderAliases: appModel.LOCAL_PROVIDER_ALIASES,
    reservedProviderPrefixes: [...appModel.RESERVED_PROVIDER_PREFIXES].sort(),
    builtinModelAliases: coreModel.BUILTIN_MODEL_ALIASES,
    modelPrefixProviders: coreModel.MODEL_PREFIX_PROVIDERS.map(([re, provider]) => [re.source, provider]),
    maxComboDepth: MAX_COMBO_DEPTH,
    // combo.js's detectRequiredCapabilities and the Claude search hooks.
    searchToolTypes: [...SEARCH_TOOL_TYPES].sort(),
    webSearchToolType: CLAUDE_BLOCK.WEB_SEARCH_TOOL,
  };
  return JSON.stringify(tables, null, 2) + "\n";
}

const MODELS = [
  "main", "main[1m]", "MAIN", "nested", "self", "empty", "mixed", "with[1m]", "with", "grok-build", "stringModels", "brokenModels",
  "fast", "objectAlias", "objectBuiltin", "halfObject", "noSlash", "falsy", "numberAlias", "builtinTarget",
  "hot/model-a", "hot/model-b(high)", "hot/model-a[1m]", "hot/model-a[200K]", "hot/a/b", "hot/",
  "resp/model", "anth/model", "both/model", "emb/model", "openai/gpt-x", "xmtp/model", "/model",
  "cc/claude-x", "claude/claude-x", "unknownprefix/model", "7/model",
  "claude-opus-5", "Claude-Opus-5", "gemini-3", "gpt-5", "o3-mini", "o2", "deepseek-r1", "llama-3", "",
  "model[1m]", "model[1M]", "model[12k]", "model[m]", "model[1g]", "model [1m]",
];

async function resolve(model) {
  const out = { model };
  try {
    const info = await appModel.getModelInfo(model);
    out.info = { provider: info.provider ?? null, model: info.model ?? null };
  } catch (error) {
    out.info = { threw: String(error?.message || error) };
  }
  try {
    const members = await appModel.getComboModels(model);
    out.comboModels = members ?? null;
  } catch (error) {
    out.comboModels = { threw: String(error?.message || error) };
  }
  out.comboLookupName = appModel.comboLookupName(model);
  return out;
}

// The rows as Node stored them, for the Go test to load.
const dump = () => ({
  providerNodes: adapter.all(`SELECT * FROM providerNodes ORDER BY rowid`),
  combos: adapter.all(`SELECT * FROM combos ORDER BY rowid`),
  kv: adapter.all(`SELECT * FROM kv WHERE scope = 'modelAliases' ORDER BY rowid`),
});

describe("model and combo resolution fixtures for the Go gateway", () => {
  it("keeps the table export the Go port embeds", () => {
    if (RECORD) writeFileSync(TABLES_FILE, tablesText());
    expect(readFileSync(TABLES_FILE, "utf8"), "regenerate with COMBO_RECORD=1").toBe(tablesText());
  });

  it("resolves every model id as the committed fixture says", async () => {
    const cases = [];
    for (const model of MODELS) cases.push(await resolve(model));
    // The out-of-order nodes really are matched by row order.
    expect(cases.find((c) => c.model === "hot/model-a").info.provider).toBe("openai-compatible-chat-b002");
    const text = JSON.stringify({ rows: dump(), cases }, null, 1) + "\n";
    if (RECORD) writeFileSync(FIXTURE_FILE, text);
    expect(readFileSync(FIXTURE_FILE, "utf8"), "Node's model resolution changed: regenerate with COMBO_RECORD=1 and update gateway/internal/combo").toBe(text);
  });
});
