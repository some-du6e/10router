import { parseJson, stringifyJson } from "../helpers/jsonCol.js";
import { stripRetiredSettings } from "../helpers/retiredSettings.js";

const migration = {
  version: 4,
  name: "remove-token-saver",
  up(db) {
    const row = db.get("SELECT data FROM settings WHERE id = 1");
    if (row) {
      db.run("UPDATE settings SET data = ? WHERE id = 1", [
        stringifyJson(stripRetiredSettings(parseJson(row.data, {}))),
      ]);
    }
  },
};

export default migration;
