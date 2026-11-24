import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "./jsonCol.js";
import { CONFIG_KV_SCOPES, writeConfig } from "./configGeneration.js";

export function makeKv(scope) {
  // Writes to a scope the gateway caches move _meta.configGeneration with them.
  const write = CONFIG_KV_SCOPES.has(scope) ? writeConfig : (db, fn) => db.transaction(fn);
  return {
    async get(key, fallback = null) {
      const db = await getAdapter();
      const row = db.get(`SELECT value FROM kv WHERE scope = ? AND key = ?`, [scope, key]);
      return row ? parseJson(row.value, fallback) : fallback;
    },
    async getAll() {
      const db = await getAdapter();
      const rows = db.all(`SELECT key, value FROM kv WHERE scope = ?`, [scope]);
      const out = {};
      for (const r of rows) out[r.key] = parseJson(r.value);
      return out;
    },
    async set(key, value) {
      const db = await getAdapter();
      write(db, () => {
        db.run(`INSERT INTO kv(scope, key, value) VALUES(?, ?, ?) ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`, [scope, key, stringifyJson(value)]);
      });
    },
    async setMany(obj) {
      const db = await getAdapter();
      write(db, () => {
        for (const [k, v] of Object.entries(obj)) {
          db.run(`INSERT INTO kv(scope, key, value) VALUES(?, ?, ?) ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`, [scope, k, stringifyJson(v)]);
        }
      });
    },
    async remove(key) {
      const db = await getAdapter();
      write(db, () => {
        db.run(`DELETE FROM kv WHERE scope = ? AND key = ?`, [scope, key]);
      });
    },
    async clear() {
      const db = await getAdapter();
      write(db, () => {
        db.run(`DELETE FROM kv WHERE scope = ?`, [scope]);
      });
    },
  };
}
