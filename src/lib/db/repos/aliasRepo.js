import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";
import { makeKv } from "../helpers/kvStore.js";
import { makeReadCache } from "../helpers/readCache.js";

const aliasKv = makeKv("modelAliases");
const customKv = makeKv("customModels");

// Every routed request resolves its model through the alias map, so keep it
// in memory instead of re-reading and re-parsing the whole scope each time.
const aliasCache = makeReadCache("modelAliases", async () => {
  const aliases = await aliasKv.getAll();
  for (const value of Object.values(aliases)) if (value && typeof value === "object") Object.freeze(value);
  return Object.freeze(aliases);
});

/** Bust the cached alias map. Call after any write to the `modelAliases` kv scope. */
export function invalidateModelAliasCache() {
  aliasCache.invalidate();
}

// modelAliases: key=alias, value=modelString
// Returns the cached map itself, frozen: copying a large map per request would
// cost more than the DB read it replaces. Copy it before editing.
export async function getModelAliases() {
  return await aliasCache.get();
}

export async function setModelAlias(alias, model) {
  await aliasKv.set(alias, model);
  aliasCache.invalidate();
}

export async function deleteModelAlias(alias) {
  await aliasKv.remove(alias);
  aliasCache.invalidate();
}

// customModels: key=`${providerAlias}|${id}|${type}`, value=full model object
function customKey(providerAlias, id, type) {
  return `${providerAlias}|${id}|${type}`;
}

export async function getCustomModels() {
  const all = await customKv.getAll();
  return Object.values(all);
}

// Atomic upsert inside transaction to prevent duplicate races.
// Re-adding an existing model updates caps/name without resetting omitted fields.
export async function addCustomModel({ providerAlias, id, type = "llm", name, caps }) {
  const k = customKey(providerAlias, id, type);
  const db = await getAdapter();
  let added = false;
  db.transaction(() => {
    const row = db.get(`SELECT value FROM kv WHERE scope = 'customModels' AND key = ?`, [k]);
    if (row) {
      const prev = parseJson(row.value) || {};
      const next = { ...prev, ...(name ? { name } : {}), ...(caps ? { caps } : {}) };
      db.run(`UPDATE kv SET value = ? WHERE scope = 'customModels' AND key = ?`, [stringifyJson(next), k]);
      return;
    }
    const value = stringifyJson({ providerAlias, id, type, name: name || id, ...(caps ? { caps } : {}) });
    db.run(`INSERT INTO kv(scope, key, value) VALUES('customModels', ?, ?)`, [k, value]);
    added = true;
  });
  return added;
}

export async function deleteCustomModel({ providerAlias, id, type = "llm" }) {
  await customKv.remove(customKey(providerAlias, id, type));
}
