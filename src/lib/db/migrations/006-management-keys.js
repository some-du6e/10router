// Scoped management keys: the managementKeys and managementAudit tables, and an
// owner column on apiKeys and providerConnections recording which management
// key created each row. Every new column is nullable, so existing rows read as
// created in the dashboard. See docs/MANAGEMENT_KEYS.md.
import { TABLES, buildCreateTableSql } from "../schema.js";

const OWNER_COLUMN = "ownerManagementKeyId";

const migration = {
  version: 6,
  name: "management-keys",
  up(db) {
    for (const name of ["managementKeys", "managementAudit"]) {
      db.exec(buildCreateTableSql(name, TABLES[name]));
      for (const index of TABLES[name].indexes || []) db.exec(index);
    }
    for (const table of ["apiKeys", "providerConnections"]) {
      const existing = new Set(db.all(`PRAGMA table_info(${table})`).map((c) => c.name));
      if (!existing.has(OWNER_COLUMN)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${OWNER_COLUMN} ${TABLES[table].columns[OWNER_COLUMN]}`);
    }
    db.exec(`CREATE INDEX IF NOT EXISTS idx_ak_owner ON apiKeys(${OWNER_COLUMN})`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_pc_owner ON providerConnections(${OWNER_COLUMN})`);
  },
};

export default migration;
