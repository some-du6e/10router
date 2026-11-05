// Seed a throwaway 10router DB with one OpenAI-compatible endpoint ("mock/<model>")
// pointing at mock-upstream.mjs. Run from the app checkout:
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
const node = { id: "openai-compatible-mock", type: "openai-compatible", name: "Mock", prefix: "mock", apiType: "chat", baseUrl };

await importDb({
  settings: { requireLogin: true, requireApiKey: false, limitHoldEnabled: false },
  providerNodes: [node],
  providerConnections: [{
    id: "mock-key-1",
    provider: node.id,
    authType: "apikey",
    name: "mock key",
    apiKey: "sk-mock-not-a-real-key",
    priority: 1,
    isActive: true,
    testStatus: "active",
    providerSpecificData: { baseUrl, prefix: node.prefix, apiType: node.apiType, nodeName: node.name },
    createdAt: now,
    updatedAt: now,
  }],
  // Requests through the tunnel aren't local, so they need a 10router key.
  apiKeys: [{
    id: "e2e-key",
    key: process.env.E2E_API_KEY || "sk-e2e-fake",
    name: "e2e",
    machineId: "e2e-machine",
    isActive: true,
    createdAt: now,
  }],
});
console.log(`seeded ${node.id} -> ${baseUrl} in ${DATA_DIR}`);
