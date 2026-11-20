// Per-key spend limits: budget, model allowlist, expiry, and the running spend
// totals the request path checks them against. Every new column is nullable or
// zero by default, so an existing key keeps working exactly as before.
import { TABLES } from "../schema.js";
import { reseedApiKeySpend } from "../repos/apiKeysRepo.js";

const migration = {
  version: 5,
  name: "api-key-budgets",
  up(db) {
    // A fresh database already has the columns from 001, which builds the current schema.
    const existing = new Set(db.all("PRAGMA table_info(apiKeys)").map((c) => c.name));
    for (const [name, def] of Object.entries(TABLES.apiKeys.columns)) {
      if (!existing.has(name)) db.exec(`ALTER TABLE apiKeys ADD COLUMN ${name} ${def}`);
    }
    for (const index of TABLES.usageHistory.indexes || []) db.exec(index);
    reseedApiKeySpend(db);
  },
};

export default migration;
