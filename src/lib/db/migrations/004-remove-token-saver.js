import { parseJson, stringifyJson } from "../helpers/jsonCol.js";
import { stripRetiredSettings } from "../helpers/retiredSettings.js";

const migration = {
  version: 4,
  name: "remove-token-saver",
  up(db) {
    const row = db.get("SELECT data FROM settings WHERE id = 1");
    const settings = row ? parseJson(row.data, null) : null;
    // Leave unreadable settings alone rather than replacing them with {}.
    if (settings && typeof settings === "object" && !Array.isArray(settings)) {
      db.run("UPDATE settings SET data = ? WHERE id = 1", [
        stringifyJson(stripRetiredSettings(settings)),
      ]);
    }

    // Load one row at a time: request details can be large.
    const ids = db.all(`SELECT id FROM requestDetails WHERE data LIKE '%"pxpipe"%'`);
    for (const { id } of ids) {
      const data = parseJson(db.get("SELECT data FROM requestDetails WHERE id = ?", [id])?.data, null);
      if (!data || typeof data !== "object" || !("pxpipe" in data)) continue;
      delete data.pxpipe;
      db.run("UPDATE requestDetails SET data = ? WHERE id = ?", [stringifyJson(data), id]);
    }
  },
};

export default migration;
