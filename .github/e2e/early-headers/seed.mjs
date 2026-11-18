// Seed a throwaway 10router DB with OpenAI-compatible endpoints ("<prefix>/<model>")
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
// "mock" has one key. "dual" and "dead" have two, so account fallback runs:
// dual/outage* is the prod outage (first key hangs then 500s, the next answers),
// dead/allfail* fails on every key. Separate nodes keep their cooldowns apart.
const nodes = [["mock", 1], ["dual", 2], ["dead", 2]].map(([prefix, keys]) => ({
  node: { id: `openai-compatible-${prefix}`, type: "openai-compatible", name: prefix, prefix, apiType: "chat", baseUrl },
  keys,
}));

await importDb({
  settings: { requireLogin: true, requireApiKey: false, limitHoldEnabled: false },
  providerNodes: nodes.map((n) => n.node),
  providerConnections: nodes.flatMap(({ node: n, keys }) => Array.from({ length: keys }, (_, i) => ({
    id: `${n.prefix}-key-${i + 1}`,
    provider: n.id,
    authType: "apikey",
    name: `${n.prefix} key ${i + 1}`,
    apiKey: "sk-mock-not-a-real-key",
    priority: i + 1,
    isActive: true,
    testStatus: "active",
    providerSpecificData: { baseUrl, prefix: n.prefix, apiType: n.apiType, nodeName: n.name },
    createdAt: now,
    updatedAt: now,
  }))),
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
console.log(`seeded ${nodes.map((n) => n.node.id).join(", ")} -> ${baseUrl} in ${DATA_DIR}`);
