// Seed for the shadow E2E (shadow.sh): two OpenAI-compatible nodes whose
// models go to the Messages API of the mock upstream, two keys each, combos
// over them, and the inputs the native route builds itself:
//   "sh/<model>"  - settings.providerThinking leaves it alone
//   "sht/<model>" - settings.providerThinking sets mode "high"
//   sk-shadow-budget - a 10router key with a budget (speed and service_tier
//                      don't go upstream)
//   model-catalog.json - a maxOutput for CATALOG_MODEL on "sh" (Prepare clamps
//                        max_tokens to it); the container runs with
//                        MODEL_CATALOG_SYNC=off so Node never rewrites it
// Run from the app checkout:
//   DATA_DIR=... node --experimental-loader=./scripts/resolve-src-alias.mjs <this file>
// Credentials are fake; the mock accepts anything.
import { writeFileSync } from "node:fs";
import path from "node:path";

if (!process.env.DATA_DIR) {
  console.error("seed: set DATA_DIR");
  process.exit(1);
}
const app = process.cwd();
const { DATA_DIR } = await import(path.join(app, "src/lib/dataDir.js"));
if (path.resolve(DATA_DIR) !== path.resolve(process.env.DATA_DIR)) {
  console.error(`seed: DATA_DIR resolved to ${DATA_DIR}`);
  process.exit(1);
}
const { importDb } = await import(path.join(app, "src/lib/db/index.js"));
const { buildCorpus, THINKING_MODELS } = await import(path.join(app, "tests/helpers/claudeprepCorpus.js"));
const { CATALOG_FILE } = await import(path.join(app, "open-sse/providers/catalogOverride.js"));

// shadow-drive.mjs and shadow.sh name the same model and limit.
const CATALOG_MODEL = "zz-catalog-probe-1";
const CATALOG_MAX_OUTPUT = 3000;

const baseUrl = process.env.MOCK_BASE_URL || "http://127.0.0.1:9998/v1";
const now = new Date().toISOString();
const bare = (model) => model.replace(/\([^()]+\)\s*$/, "").trim();
const models = [...new Set([...THINKING_MODELS, CATALOG_MODEL, ...buildCorpus().map((f) => bare(f.inputs.model))])].sort();
const modelRoutes = Object.fromEntries(models.map((m) => [m, "anthropic"]));
const nodes = [["sh", "openai-compatible-chat-shadow"], ["sht", "openai-compatible-chat-shadow-thinking"]].map(([prefix, id]) => ({
  id, prefix, settings: { baseUrl, prefix, apiType: "chat", modelRoutes },
}));

await importDb({
  settings: {
    requireLogin: true,
    requireApiKey: false,
    limitHoldEnabled: false,
    providerThinking: { "openai-compatible-chat-shadow-thinking": { mode: "high" } },
  },
  providerNodes: nodes.map((n) => ({ id: n.id, type: "openai-compatible", name: n.prefix, ...n.settings })),
  providerConnections: nodes.flatMap((n) => [1, 2].map((i) => ({
    id: `${n.prefix}-key-${i}`,
    provider: n.id,
    authType: "apikey",
    name: `${n.prefix} key ${i}`,
    apiKey: `sk-${n.prefix}-not-a-real-key-${i}`,
    priority: i,
    isActive: true,
    testStatus: "active",
    providerSpecificData: { ...n.settings, nodeName: n.prefix },
    createdAt: now,
    updatedAt: now,
  }))),
  apiKeys: [{ id: "shadow-budget", key: "sk-shadow-budget", name: "shadow budget", machineId: "e2e-machine", isActive: true, budgetUsd: 1000, createdAt: now }],
  combos: [
    { id: "combo-shadow-main", name: "shadow-main", models: ["sh/claude-opus-4-8", "sh/claude-sonnet-4-6"], createdAt: now, updatedAt: now },
    { id: "combo-shadow-outer", name: "shadow-outer", models: ["shadow-main", "sht/claude-haiku-4-5"], createdAt: now, updatedAt: now },
  ],
});
writeFileSync(CATALOG_FILE, JSON.stringify({
  models: {},
  providers: { "openai-compatible-chat-shadow": { [CATALOG_MODEL]: { maxOutput: CATALOG_MAX_OUTPUT } } },
}));
console.log(`seeded ${nodes.map((n) => n.id).join(", ")} (${models.length} models to the Messages API) -> ${baseUrl}, and ${CATALOG_FILE}, in ${DATA_DIR}`);
