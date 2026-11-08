// Scoped management keys: the managementKeys and managementAudit tables, an
// owner column on apiKeys and providerConnections recording which management
// key created each row, and who last turned a client key off or set its
// expiry. Every new column is nullable, so existing rows read as made in the
// dashboard. Columns and indexes come from TABLES. See docs/MANAGEMENT_KEYS.md.
import { TABLES, buildCreateTableSql } from "../schema.js";

const NEW_COLUMNS = {
  apiKeys: ["ownerManagementKeyId", "disabledBy", "expiresAtSetBy"],
  providerConnections: ["ownerManagementKeyId"],
};

const migration = {
  version: 6,
  name: "management-keys",
  up(db) {
    for (const name of ["managementKeys", "managementAudit"]) {
      db.exec(buildCreateTableSql(name, TABLES[name]));
      const existing = new Set(db.all(`PRAGMA table_info(${name})`).map((c) => c.name));
      for (const [col, def] of Object.entries(TABLES[name].columns)) {
        if (!existing.has(col)) db.exec(`ALTER TABLE ${name} ADD COLUMN ${col} ${def}`);
      }
      for (const index of TABLES[name].indexes || []) db.exec(index);
    }
    for (const [table, columns] of Object.entries(NEW_COLUMNS)) {
      const existing = new Set(db.all(`PRAGMA table_info(${table})`).map((c) => c.name));
      for (const col of columns) {
        if (!existing.has(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${TABLES[table].columns[col]}`);
      }
      for (const index of TABLES[table].indexes || []) db.exec(index);
    }
  },
};

export default migration;
