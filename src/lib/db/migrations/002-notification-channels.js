import { TABLES, buildCreateTableSql } from "../schema.js";

const migration = {
  version: 2,
  name: "notification-channels",
  up(db) {
    const definition = TABLES.notificationChannels;
    db.exec(buildCreateTableSql("notificationChannels", definition));
    for (const index of definition.indexes || []) db.exec(index);
  },
};

export default migration;
