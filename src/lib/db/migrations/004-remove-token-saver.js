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

    const details = db.all(`SELECT id, data FROM requestDetails WHERE data LIKE '%"pxpipe"%'`);
    for (const detail of details) {
      const data = parseJson(detail.data, null);
      if (!data || typeof data !== "object" || !("pxpipe" in data)) continue;
      delete data.pxpipe;
      db.run("UPDATE requestDetails SET data = ? WHERE id = ?", [stringifyJson(data), detail.id]);
    }
  },
};

export default migration;
