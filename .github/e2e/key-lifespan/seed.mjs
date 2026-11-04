// Seeds a throwaway DATA_DIR for the key lifespan E2E through the app's own DB
// layer. Fake keys only. Run with scripts/resolve-src-alias.mjs as the loader.
if (!process.env.DATA_DIR) {
  console.error("seed: set DATA_DIR to a throwaway directory");
  process.exit(1);
}

const { importDb } = await import("../../../src/lib/db/index.js");
const { getAdapter } = await import("../../../src/lib/db/driver.js");

const now = Date.now();
const iso = (hoursAgo) => new Date(now - hoursAgo * 3600 * 1000).toISOString();

const ALPHA = "openai-compatible-e2e-alpha";
const BETA = "openai-compatible-e2e-beta";

const node = (id, name, prefix) => ({
  id, type: "openai-compatible", name, prefix, apiType: "chat", baseUrl: `https://${prefix}.e2e.invalid/v1`,
});

const key = (provider, id, name, { active = true, autoDisabled = false, prefix } = {}) => ({
  id, provider, authType: "apikey", name, priority: 1, isActive: active,
  apiKey: `sk-e2e-fake-${id}`,
  testStatus: active ? "active" : "error",
  ...(autoDisabled ? { autoDisabledAt: iso(24), autoDisabledReason: "auth failed (e2e)" } : {}),
  providerSpecificData: { baseUrl: `https://${prefix}.e2e.invalid/v1`, prefix, apiType: "chat", nodeName: prefix },
  createdAt: iso(24 * 30), updatedAt: iso(24),
});

const deadCosts = [419, 419, 454, 529, 552, 565, 646, 655, 717];
const alphaDead = deadCosts.map((cost, i) => ({ conn: key(ALPHA, `alpha-dead-${i + 1}`, `alpha-dead-${i + 1}`, { active: false, autoDisabled: true, prefix: "e2ea" }), cost }));
const alphaEarly = { conn: key(ALPHA, "alpha-early", "alpha-early", { active: false, autoDisabled: true, prefix: "e2ea" }), cost: 42 };
// Turned off by hand (no autoDisabledAt): must not count as a dead key.
const alphaManual = { conn: key(ALPHA, "alpha-manual-off", "alpha-manual-off", { active: false, prefix: "e2ea" }), cost: 2000 };
const alphaActive = key(ALPHA, "alpha-active", "alpha-active", { prefix: "e2ea" });

const betaDead = [300, 500].map((cost, i) => ({ conn: key(BETA, `beta-dead-${i + 1}`, `beta-dead-${i + 1}`, { active: false, autoDisabled: true, prefix: "e2eb" }), cost }));
const betaActive = key(BETA, "beta-active", "beta-active", { prefix: "e2eb" });

await importDb({
  settings: { requireLogin: true, requireApiKey: false },
  providerNodes: [node(ALPHA, "E2E Alpha", "e2ea"), node(BETA, "E2E Beta", "e2eb")],
  providerConnections: [
    ...alphaDead.map((d) => d.conn), alphaEarly.conn, alphaManual.conn, alphaActive,
    ...betaDead.map((d) => d.conn), betaActive,
  ],
});

const db = await getAdapter();
const insert = (provider, connectionId, cost, hoursAgo, status = "ok") => db.run(
  `INSERT INTO usageHistory(timestamp, provider, model, connectionId, apiKey, endpoint, promptTokens, completionTokens, cost, status, tokens, meta)
   VALUES(?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, '{}', '{}')`,
  [iso(hoursAgo), provider, "gpt-e2e", connectionId, Math.round(cost * 1000), Math.round(cost * 100), cost, status],
);

db.transaction(() => {
  // Each dead key's total is split over two rows days ago.
  for (const { conn, cost } of [...alphaDead, alphaEarly, alphaManual]) {
    insert(ALPHA, conn.id, cost * 0.6, 24 * 20);
    insert(ALPHA, conn.id, cost * 0.4, 24 * 5);
  }
  // Active: $200 two days ago, $30 in the last 6h, and a failed $1000 that must be ignored.
  insert(ALPHA, alphaActive.id, 200, 48);
  insert(ALPHA, alphaActive.id, 10, 5);
  insert(ALPHA, alphaActive.id, 10, 3);
  insert(ALPHA, alphaActive.id, 10, 1);
  insert(ALPHA, alphaActive.id, 1000, 2, "error");
  for (const { conn, cost } of betaDead) insert(BETA, conn.id, cost, 24 * 4);
  insert(BETA, betaActive.id, 50, 2);
});

const rows = db.all(`SELECT provider, COUNT(*) AS n, SUM(cost) AS cost FROM usageHistory GROUP BY provider`);
console.log("seeded usageHistory:", JSON.stringify(rows));
const conns = db.all(`SELECT provider, COUNT(*) AS n FROM providerConnections GROUP BY provider`);
console.log("seeded providerConnections:", JSON.stringify(conns));
