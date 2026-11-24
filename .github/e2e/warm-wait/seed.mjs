// Seed a throwaway 10router DB with one OpenAI-compatible endpoint ("ww/<model>")
// pointing at mock-upstream.mjs, with two keys: "ww-warm" (ranked first) and
// "ww-cold". Run from the app checkout:
//   DATA_DIR=... node --experimental-loader=./scripts/resolve-src-alias.mjs <this file>
// Credentials are fake; the mock tells the keys apart by them.
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

const baseUrl = process.env.MOCK_BASE_URL || "http://127.0.0.1:9998/v1";
const now = new Date().toISOString();
const node = { id: "openai-compatible-ww", type: "openai-compatible", name: "ww", prefix: "ww", apiType: "chat", baseUrl };

await importDb({
  settings: { requireLogin: true, requireApiKey: false, limitHoldEnabled: false, enableObservability: true },
  providerNodes: [node],
  providerConnections: ["warm", "cold"].map((role, i) => ({
    id: `ww-${role}`,
    provider: node.id,
    authType: "apikey",
    name: `ww ${role}`,
    apiKey: `sk-ww-${role}-not-a-real-key`,
    priority: i + 1,
    isActive: true,
    testStatus: "active",
    providerSpecificData: { baseUrl, prefix: node.prefix, apiType: node.apiType, nodeName: node.name },
    createdAt: now,
    updatedAt: now,
  })),
});
console.log(`seeded ${node.id} (warm, cold) -> ${baseUrl} in ${DATA_DIR}`);
