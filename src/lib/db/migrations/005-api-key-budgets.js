// Per-key spend limits: budget, model allowlist, expiry, and the running spend
// totals the request path checks them against. Every new column is nullable or
// zero by default, so an existing key keeps working exactly as before.

const COLUMNS = {
  budgetUsd: "REAL",
  allowedModels: "TEXT",
  expiresAt: "TEXT",
  spentUsd: "REAL DEFAULT 0",
  spendOffsetUsd: "REAL DEFAULT 0",
  spendResetAt: "TEXT",
  requestCount: "INTEGER DEFAULT 0",
  lastUsedAt: "TEXT",
};

/**
 * Recompute every key's running totals from usageHistory. Leaves the reset
 * offset alone, so a key's spend since its last reset stays what it was.
 * Run once per migration or restore, never per request.
 */
export function reseedApiKeySpend(db) {
  db.run(`
    UPDATE apiKeys SET
      spentUsd = COALESCE((SELECT SUM(cost) FROM usageHistory WHERE usageHistory.apiKey = apiKeys.key), 0),
      requestCount = (SELECT COUNT(*) FROM usageHistory WHERE usageHistory.apiKey = apiKeys.key),
      lastUsedAt = (SELECT MAX(timestamp) FROM usageHistory WHERE usageHistory.apiKey = apiKeys.key)
  `);
}

const migration = {
  version: 5,
  name: "api-key-budgets",
  up(db) {
    // A fresh database already has these from 001, which builds the current schema.
    const existing = new Set(db.all("PRAGMA table_info(apiKeys)").map((c) => c.name));
    for (const [name, def] of Object.entries(COLUMNS)) {
      if (!existing.has(name)) db.exec(`ALTER TABLE apiKeys ADD COLUMN ${name} ${def}`);
    }
    db.exec("CREATE INDEX IF NOT EXISTS idx_uh_apikey ON usageHistory(apiKey, cost)");
    reseedApiKeySpend(db);
  },
};

export default migration;
