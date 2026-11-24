// Golden fixtures for the Go gateway's model and combo resolution
// (gateway/internal/combo, docs/GO_GATEWAY.md "Parity testing").
//
// Each model id goes through Node's real getModelInfo and getComboModels
// (src/sse/services/model.js) over one synthetic database: custom nodes with
// prefixes, combos (nested, empty, with non-string members), and aliases of
// every stored shape. The Go test must give the same answers.
//
// Without COMBO_RECORD this checks that Node still gives the committed answers
// and table export, so a Node change the Go port would miss fails here too.
// With COMBO_RECORD=1 it writes them.
import { describe, it, expect, vi } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const config = {
  nodes: [
    { id: "openai-compatible-chat-0001", type: "openai-compatible", prefix: "hot" },
    { id: "openai-compatible-chat-0002", type: "openai-compatible", prefix: "hot" },
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

vi.mock("@/lib/localDb", () => ({
  getModelAliases: async () => structuredClone(config.aliases),
  getComboByName: async (name) => {
    if (!Object.hasOwn(config.combos, name)) return null;
    return { id: `combo-${name}`, name, kind: null, models: structuredClone(config.combos[name]) };
  },
  getProviderNodes: async ({ type } = {}) => config.nodes.filter((n) => !type || n.type === type).map((n) => ({ ...n })),
}));

const coreModel = await import("../../open-sse/services/model.js");
const appModel = await import("../../src/sse/services/model.js");
const { MAX_COMBO_DEPTH } = await import("../../open-sse/config/runtimeConfig.js");

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
  };
  return JSON.stringify(tables, null, 2) + "\n";
}

const MODELS = [
  "main", "main[1m]", "MAIN", "nested", "self", "empty", "mixed", "with[1m]", "with", "grok-build",
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

describe("model and combo resolution fixtures for the Go gateway", () => {
  it("keeps the table export the Go port embeds", () => {
    if (RECORD) writeFileSync(TABLES_FILE, tablesText());
    expect(readFileSync(TABLES_FILE, "utf8"), "regenerate with COMBO_RECORD=1").toBe(tablesText());
  });

  it("resolves every model id as the committed fixture says", async () => {
    const cases = [];
    for (const model of MODELS) cases.push(await resolve(model));
    const text = JSON.stringify({ config, cases }, null, 1) + "\n";
    if (RECORD) writeFileSync(FIXTURE_FILE, text);
    expect(readFileSync(FIXTURE_FILE, "utf8"), "Node's model resolution changed: regenerate with COMBO_RECORD=1 and update gateway/internal/combo").toBe(text);
  });
});
