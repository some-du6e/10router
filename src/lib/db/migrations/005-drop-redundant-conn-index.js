// idx_uh_conn (connectionId) is a prefix of idx_uh_conn_ok, which serves every
// lookup by connectionId, so it only cost writes and disk. The additive schema
// sync never drops indexes, hence this migration.
const migration = {
  version: 5,
  name: "drop-redundant-conn-index",
  up(db) {
    db.exec("DROP INDEX IF EXISTS idx_uh_conn");
  },
};

export default migration;
