// Initial schema bootstrap. For fresh DB this creates all tables/indexes.
// For existing DB at version 0 (legacy unstamped), it's idempotent (IF NOT EXISTS).
import { TABLES, buildCreateTableSql } from "../schema.js";

export default {
  version: 1,
  name: "initial",
  up(db) {
    for (const [name, def] of Object.entries(TABLES)) {
      db.exec(buildCreateTableSql(name, def));
      for (const idx of def.indexes || []) {
        // On a legacy table, an index on a column a later migration adds
        // can't be built yet; that migration (and syncSchemaFromTables) builds it.
        try {
          db.exec(idx);
        } catch (e) {
          if (!/no such column/i.test(String(e?.message))) throw e;
        }
      }
    }
  },
};
