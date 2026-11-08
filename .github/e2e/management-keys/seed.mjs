// Seed a throwaway 10router DB for the management-keys CLI E2E: an
// Anthropic-compatible node "mc" pointing at ../key-budgets/mock-upstream.mjs,
// with two enabled models so GET /v1/models has something to filter, and
// requireApiKey on so a deleted client key is refused. Credentials are fake.
//   DATA_DIR=... node --experimental-loader=./scripts/resolve-src-alias.mjs <this file>
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
const node = { id: "anthropic-compatible-mockc", type: "anthropic-compatible", name: "mockc", prefix: "mc", baseUrl };

await importDb({
  settings: { requireLogin: true, requireApiKey: true, limitHoldEnabled: false },
  providerNodes: [node],
  providerConnections: [{
    id: "mc-key-1",
    provider: node.id,
    authType: "apikey",
    name: "mc key 1",
    apiKey: "sk-mock-not-a-real-key",
    priority: 1,
    isActive: true,
    testStatus: "active",
    providerSpecificData: { baseUrl, prefix: node.prefix, nodeName: node.name, enabledModels: ["claude-opus-5-5", "claude-sonnet-5"] },
    createdAt: now,
    updatedAt: now,
  }],
});
console.log(`seeded ${node.id} -> ${baseUrl} in ${DATA_DIR}`);
