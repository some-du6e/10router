import { parseJson, stringifyJson } from "../helpers/jsonCol.js";
import { stripRetiredSettings } from "../helpers/retiredSettings.js";

const migration = {
  version: 3,
  name: "remove-ide-proxy",
  up(db) {
    db.run("DELETE FROM kv WHERE scope = 'mitmAlias'");
    const row = db.get("SELECT data FROM settings WHERE id = 1");
    if (row) {
      db.run("UPDATE settings SET data = ? WHERE id = 1", [
        stringifyJson(stripRetiredSettings(parseJson(row.data, {}))),
      ]);
    }
  },
};

export default migration;
