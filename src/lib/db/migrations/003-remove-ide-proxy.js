import { parseJson, stringifyJson } from "../helpers/jsonCol.js";
import { stripRetiredSettings } from "../helpers/retiredSettings.js";
import { migrateLegacyHostPassword } from "../helpers/hostCredentials.js";

const migration = {
  version: 3,
  name: "remove-ide-proxy",
  up(db) {
    db.run("DELETE FROM kv WHERE scope = 'mitmAlias'");
    const row = db.get("SELECT data FROM settings WHERE id = 1");
    if (row) {
      const settings = parseJson(row.data, {});
      migrateLegacyHostPassword(db, settings);
      db.run("UPDATE settings SET data = ? WHERE id = 1", [
        stringifyJson(stripRetiredSettings(settings)),
      ]);
    }
  },
};

export default migration;
