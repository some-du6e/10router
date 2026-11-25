// Seed for the shadow E2E (shadow.sh): one OpenAI-compatible node ("sh/<model>")
// whose models go to the Messages API of shadow-upstream.mjs, two keys, and
// combos over it. Run from the app checkout:
//   DATA_DIR=... node --experimental-loader=./scripts/resolve-src-alias.mjs <this file>
// Credentials are fake; the mock accepts anything.
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

const baseUrl = process.env.MOCK_BASE_URL || "http://127.0.0.1:9998/v1";
const now = new Date().toISOString();
const bare = (model) => model.replace(/\([^()]+\)\s*$/, "").trim();
const models = [...new Set([...THINKING_MODELS, ...buildCorpus().map((f) => bare(f.inputs.model))])].sort();
const modelRoutes = Object.fromEntries(models.map((m) => [m, "anthropic"]));
const id = "openai-compatible-chat-shadow";
const settings = { baseUrl, prefix: "sh", apiType: "chat", modelRoutes };

await importDb({
  settings: { requireLogin: true, requireApiKey: false, limitHoldEnabled: false },
  providerNodes: [{ id, type: "openai-compatible", name: "shadow", ...settings }],
  providerConnections: [1, 2].map((i) => ({
    id: `sh-key-${i}`,
    provider: id,
    authType: "apikey",
    name: `shadow key ${i}`,
    apiKey: `sk-shadow-not-a-real-key-${i}`,
    priority: i,
    isActive: true,
    testStatus: "active",
    providerSpecificData: { ...settings, nodeName: "shadow" },
    createdAt: now,
    updatedAt: now,
  })),
  combos: [
    { id: "combo-shadow-main", name: "shadow-main", models: ["sh/claude-opus-4-8", "sh/claude-sonnet-4-6"], createdAt: now, updatedAt: now },
    { id: "combo-shadow-outer", name: "shadow-outer", models: ["shadow-main", "sh/claude-haiku-4-5"], createdAt: now, updatedAt: now },
  ],
});
console.log(`seeded ${id} (${models.length} models to the Messages API) -> ${baseUrl} in ${DATA_DIR}`);
