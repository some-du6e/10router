// ⚠️ AGENT/DEV: Bump this by +1 EVERY TIME you change the schema below
// (add/remove/alter a table, column, or index in TABLES). It drives the
// pre-change safety backup in migrate.js: when the stored version is lower,
// one lightweight DB backup is taken before applying schema changes. Forgetting
// to bump only skips that backup — it does NOT break the additive auto-sync.
export const SCHEMA_VERSION = 7;

export const PRAGMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA temp_store = MEMORY;
PRAGMA mmap_size = 30000000;
PRAGMA cache_size = -64000;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
`;

// Declarative current schema. Used by syncSchemaFromTables() to
// auto-add missing tables/columns/indexes after versioned migrations.
// For destructive changes (drop/rename/type-change), write a migration file.
export const TABLES = {
  _meta: {
    columns: {
      key: "TEXT PRIMARY KEY",
      value: "TEXT NOT NULL",
    },
  },
  settings: {
    columns: {
      id: "INTEGER PRIMARY KEY CHECK (id = 1)",
      data: "TEXT NOT NULL",
    },
  },
  providerConnections: {
    columns: {
      id: "TEXT PRIMARY KEY",
      provider: "TEXT NOT NULL",
      authType: "TEXT NOT NULL",
      name: "TEXT",
      email: "TEXT",
      priority: "INTEGER",
      isActive: "INTEGER DEFAULT 1",
      data: "TEXT NOT NULL",
      createdAt: "TEXT NOT NULL",
      updatedAt: "TEXT NOT NULL",
      // The management key that added this connection (migration 006). NULL for
      // connections added in the dashboard. Never part of the data JSON.
      ownerManagementKeyId: "TEXT",
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_pc_provider ON providerConnections(provider)",
      "CREATE INDEX IF NOT EXISTS idx_pc_provider_active ON providerConnections(provider, isActive)",
      "CREATE INDEX IF NOT EXISTS idx_pc_priority ON providerConnections(provider, priority)",
      "CREATE INDEX IF NOT EXISTS idx_pc_owner ON providerConnections(ownerManagementKeyId)",
    ],
  },
  providerNodes: {
    columns: {
      id: "TEXT PRIMARY KEY",
      type: "TEXT",
      name: "TEXT",
      data: "TEXT NOT NULL",
      createdAt: "TEXT NOT NULL",
      updatedAt: "TEXT NOT NULL",
    },
    indexes: ["CREATE INDEX IF NOT EXISTS idx_pn_type ON providerNodes(type)"],
  },
  proxyPools: {
    columns: {
      id: "TEXT PRIMARY KEY",
      isActive: "INTEGER DEFAULT 1",
      testStatus: "TEXT",
      data: "TEXT NOT NULL",
      createdAt: "TEXT NOT NULL",
      updatedAt: "TEXT NOT NULL",
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_pp_active ON proxyPools(isActive)",
      "CREATE INDEX IF NOT EXISTS idx_pp_status ON proxyPools(testStatus)",
    ],
  },
  notificationChannels: {
    columns: {
      id: "TEXT PRIMARY KEY",
      name: "TEXT NOT NULL",
      type: "TEXT NOT NULL",
      isActive: "INTEGER DEFAULT 1",
      data: "TEXT NOT NULL",
      createdAt: "TEXT NOT NULL",
      updatedAt: "TEXT NOT NULL",
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_nc_active ON notificationChannels(isActive)",
      "CREATE INDEX IF NOT EXISTS idx_nc_type ON notificationChannels(type)",
    ],
  },
  apiKeys: {
    columns: {
      id: "TEXT PRIMARY KEY",
      key: "TEXT UNIQUE NOT NULL",
      name: "TEXT",
      machineId: "TEXT",
      isActive: "INTEGER DEFAULT 1",
      // Rate-limit hold override: NULL inherits the global setting, 1 = hold the
      // stream open until the limit resets, 0 = fail fast (e.g. CI keys).
      limitHold: "INTEGER",
      createdAt: "TEXT NOT NULL",
      // Spend limits (migration 005). NULL = no limit, which is how every key
      // created before them behaves.
      budgetUsd: "REAL",
      allowedModels: "TEXT",
      expiresAt: "TEXT",
      // Running totals over this key's usageHistory rows, kept current by
      // saveRequestUsage so the request path never sums history. The spend
      // counted against the budget is spentUsd - spendOffsetUsd.
      spentUsd: "REAL DEFAULT 0",
      spendOffsetUsd: "REAL DEFAULT 0",
      spendResetAt: "TEXT",
      requestCount: "INTEGER DEFAULT 0",
      lastUsedAt: "TEXT",
      // The management key that created this key (migration 006). NULL for
      // keys created in the dashboard.
      ownerManagementKeyId: "TEXT",
      // Who last turned the key off and who set its expiry: "dashboard" or a
      // management key id (migration 006). A management key may not undo the
      // dashboard's choice. NULL with the key off (or an expiry set) reads as the dashboard.
      disabledBy: "TEXT",
      expiresAtSetBy: "TEXT",
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_ak_key ON apiKeys(key)",
      "CREATE INDEX IF NOT EXISTS idx_ak_owner ON apiKeys(ownerManagementKeyId)",
    ],
  },
  // Scoped keys for the management API (/api/management/v1). Only the sha256
  // of the secret is stored; keyPrefix is a display hint. See docs/MANAGEMENT_KEYS.md.
  managementKeys: {
    columns: {
      id: "TEXT PRIMARY KEY",
      name: "TEXT NOT NULL",
      keyHash: "TEXT UNIQUE NOT NULL",
      keyPrefix: "TEXT NOT NULL",
      scopes: "TEXT NOT NULL",
      isActive: "INTEGER DEFAULT 1",
      expiresAt: "TEXT",
      createdAt: "TEXT NOT NULL",
      lastUsedAt: "TEXT",
    },
  },
  // What each management key did. detail is JSON and never holds a secret.
  managementAudit: {
    columns: {
      id: "INTEGER PRIMARY KEY AUTOINCREMENT",
      managementKeyId: "TEXT",
      action: "TEXT NOT NULL",
      targetType: "TEXT",
      targetId: "TEXT",
      at: "TEXT NOT NULL",
      detail: "TEXT",
      // 1 for a refused request. Refusals are trimmed apart from the rest, so
      // a flood of them can't push the real trail out.
      denied: "INTEGER DEFAULT 0",
    },
    indexes: ["CREATE INDEX IF NOT EXISTS idx_ma_denied ON managementAudit(denied, id)"],
  },
  combos: {
    columns: {
      id: "TEXT PRIMARY KEY",
      name: "TEXT UNIQUE NOT NULL",
      kind: "TEXT",
      models: "TEXT NOT NULL",
      createdAt: "TEXT NOT NULL",
      updatedAt: "TEXT NOT NULL",
    },
    indexes: ["CREATE INDEX IF NOT EXISTS idx_combo_name ON combos(name)"],
  },
  kv: {
    columns: {
      scope: "TEXT NOT NULL",
      key: "TEXT NOT NULL",
      value: "TEXT NOT NULL",
    },
    primaryKey: "PRIMARY KEY (scope, key)",
    indexes: ["CREATE INDEX IF NOT EXISTS idx_kv_scope ON kv(scope)"],
  },
  usageHistory: {
    columns: {
      id: "INTEGER PRIMARY KEY AUTOINCREMENT",
      timestamp: "TEXT NOT NULL",
      provider: "TEXT",
      model: "TEXT",
      connectionId: "TEXT",
      apiKey: "TEXT",
      endpoint: "TEXT",
      promptTokens: "INTEGER DEFAULT 0",
      completionTokens: "INTEGER DEFAULT 0",
      cost: "REAL DEFAULT 0",
      status: "TEXT",
      tokens: "TEXT",
      meta: "TEXT",
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_uh_ts ON usageHistory(timestamp DESC)",
      "CREATE INDEX IF NOT EXISTS idx_uh_provider ON usageHistory(provider)",
      "CREATE INDEX IF NOT EXISTS idx_uh_model ON usageHistory(model)",
      "CREATE INDEX IF NOT EXISTS idx_uh_conn ON usageHistory(connectionId)",
      // Covers the key lifespan aggregate (keyLifespanRepo.js) without touching rows.
      "CREATE INDEX IF NOT EXISTS idx_uh_conn_ok ON usageHistory(connectionId, status, timestamp, cost, promptTokens, completionTokens)",
      // Per-key spend: the migration's seed sum and the key detail view.
      "CREATE INDEX IF NOT EXISTS idx_uh_apikey ON usageHistory(apiKey, cost)",
    ],
  },
  usageDaily: {
    columns: {
      dateKey: "TEXT PRIMARY KEY",
      data: "TEXT NOT NULL",
    },
  },
  requestDetails: {
    columns: {
      id: "TEXT PRIMARY KEY",
      timestamp: "TEXT NOT NULL",
      provider: "TEXT",
      model: "TEXT",
      connectionId: "TEXT",
      status: "TEXT",
      data: "TEXT NOT NULL",
      // Gzipped, base64 JSON of the untruncated payloads. Only set when a
      // payload exceeded the preview limit, and only for recent rows.
      fullData: "TEXT",
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_rd_ts ON requestDetails(timestamp DESC)",
      "CREATE INDEX IF NOT EXISTS idx_rd_provider ON requestDetails(provider)",
      "CREATE INDEX IF NOT EXISTS idx_rd_model ON requestDetails(model)",
      "CREATE INDEX IF NOT EXISTS idx_rd_conn ON requestDetails(connectionId)",
    ],
  },
};

export function buildCreateTableSql(name, def) {
  const cols = Object.entries(def.columns).map(([k, v]) => `${k} ${v}`);
  if (def.primaryKey) cols.push(def.primaryKey);
  return `CREATE TABLE IF NOT EXISTS ${name} (${cols.join(", ")})`;
}
