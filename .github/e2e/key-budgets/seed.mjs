// Seed a throwaway 10router DB for the key budgets E2E: an Anthropic-compatible
// node "mc" and an OpenAI Responses node "mx", both pointing at
// mock-upstream.mjs. Client keys are made later through the dashboard API.
// Run from the app checkout:
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

const baseUrl = process.env.MOCK_BASE_URL || "http://127.0.0.1:9999/v1";
const now = new Date().toISOString();
const nodes = [
  { id: "anthropic-compatible-mockc", type: "anthropic-compatible", name: "mockc", prefix: "mc", baseUrl },
  { id: "openai-compatible-mockx", type: "openai-compatible", name: "mockx", prefix: "mx", apiType: "responses", baseUrl },
];

await importDb({
  settings: { requireLogin: true, requireApiKey: false, limitHoldEnabled: false },
  providerNodes: nodes,
  providerConnections: nodes.map((n) => ({
    id: `${n.prefix}-key-1`,
    provider: n.id,
    authType: "apikey",
    name: `${n.prefix} key 1`,
    apiKey: "sk-mock-not-a-real-key",
    priority: 1,
    isActive: true,
    testStatus: "active",
    providerSpecificData: { baseUrl, prefix: n.prefix, ...(n.apiType ? { apiType: n.apiType } : {}), nodeName: n.name },
    createdAt: now,
    updatedAt: now,
  })),
});
console.log(`seeded ${nodes.map((n) => n.id).join(", ")} -> ${baseUrl} in ${DATA_DIR}`);
