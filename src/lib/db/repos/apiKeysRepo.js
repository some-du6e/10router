import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";
import { spentSinceReset } from "@/shared/utils/apiKeyLimits.js";

function numberOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseAllowedModels(value) {
  const list = parseJson(value, null);
  return Array.isArray(list) && list.length ? list.filter((m) => typeof m === "string") : null;
}

function rowToKey(row) {
  if (!row) return null;
  const lifetimeSpentUsd = Number(row.spentUsd) || 0;
  const spendOffsetUsd = Number(row.spendOffsetUsd) || 0;
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    machineId: row.machineId,
    isActive: row.isActive === 1 || row.isActive === true,
    // null/undefined = inherit the global setting; only an explicit 0/1 overrides it
    limitHold: row.limitHold === null || row.limitHold === undefined ? null : (row.limitHold === 1 || row.limitHold === true),
    createdAt: row.createdAt,
    // Limits: null = none.
    budgetUsd: numberOrNull(row.budgetUsd),
    allowedModels: parseAllowedModels(row.allowedModels),
    expiresAt: row.expiresAt || null,
    // spentUsd is what counts against the budget (since the last reset);
    // lifetimeSpentUsd never goes down.
    spentUsd: spentSinceReset({ lifetimeSpentUsd, spendOffsetUsd }),
    lifetimeSpentUsd,
    spendOffsetUsd,
    spendResetAt: row.spendResetAt || null,
    requestCount: Number(row.requestCount) || 0,
    lastUsedAt: row.lastUsedAt || null,
  };
}

export async function getApiKeys() {
  const db = await getAdapter();
  const rows = db.all(`SELECT * FROM apiKeys ORDER BY createdAt ASC`);
  return rows.map(rowToKey);
}

export async function getApiKeyById(id) {
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM apiKeys WHERE id = ?`, [id]);
  return rowToKey(row);
}

export async function createApiKey(name, machineId) {
  if (!machineId) throw new Error("machineId is required");
  const db = await getAdapter();
  const { generateApiKeyWithMachine } = await import("@/shared/utils/apiKey");
  const result = generateApiKeyWithMachine(machineId);
  const apiKey = {
    id: uuidv4(),
    name,
    key: result.key,
    machineId,
    isActive: true,
    createdAt: new Date().toISOString(),
  };
  db.run(
    `INSERT INTO apiKeys(id, key, name, machineId, isActive, createdAt) VALUES(?, ?, ?, ?, ?, ?)`,
    [apiKey.id, apiKey.key, apiKey.name, apiKey.machineId, 1, apiKey.createdAt]
  );
  return apiKey;
}

export async function updateApiKey(id, data) {
  const db = await getAdapter();
  let result = null;
  db.transaction(() => {
    const row = db.get(`SELECT * FROM apiKeys WHERE id = ?`, [id]);
    if (!row) return;
    const { resetSpend, ...fields } = data;
    const merged = { ...rowToKey(row), ...fields };
    // A reset moves the baseline to the current lifetime total; usage history
    // is kept, so the dashboard still shows everything the key ever spent.
    const offset = resetSpend ? Number(row.spentUsd) || 0 : Number(row.spendOffsetUsd) || 0;
    const resetAt = resetSpend ? new Date().toISOString() : row.spendResetAt || null;
    db.run(
      `UPDATE apiKeys SET key = ?, name = ?, machineId = ?, isActive = ?, limitHold = ?,
         budgetUsd = ?, allowedModels = ?, expiresAt = ?, spendOffsetUsd = ?, spendResetAt = ? WHERE id = ?`,
      [merged.key, merged.name, merged.machineId, merged.isActive ? 1 : 0, toLimitHoldColumn(merged.limitHold),
        numberOrNull(merged.budgetUsd), merged.allowedModels?.length ? stringifyJson(merged.allowedModels) : null,
        merged.expiresAt || null, offset, resetAt, id]
    );
    result = rowToKey(db.get(`SELECT * FROM apiKeys WHERE id = ?`, [id]));
  });
  return result;
}

export async function deleteApiKey(id) {
  const db = await getAdapter();
  const res = db.run(`DELETE FROM apiKeys WHERE id = ?`, [id]);
  return (res?.changes ?? 0) > 0;
}

/** null → inherit global; anything else → explicit 0/1 */
function toLimitHoldColumn(value) {
  if (value === null || value === undefined) return null;
  return value ? 1 : 0;
}

/**
 * Read the rate-limit hold override for a raw API key.
 * @returns {Promise<boolean|null>} null when the key is unknown or inherits the global setting
 */
export async function getApiKeyLimitHold(key) {
  if (!key) return null;
  const db = await getAdapter();
  const row = db.get(`SELECT limitHold FROM apiKeys WHERE key = ?`, [key]);
  if (!row || row.limitHold === null || row.limitHold === undefined) return null;
  return row.limitHold === 1 || row.limitHold === true;
}

export async function validateApiKey(key) {
  const db = await getAdapter();
  const row = db.get(`SELECT isActive FROM apiKeys WHERE key = ?`, [key]);
  if (!row) return false;
  return row.isActive === 1 || row.isActive === true;
}

/**
 * Everything the request path needs to check a key's limits, in one indexed
 * read. Null when the key is not one 10router issued.
 */
export async function getApiKeyPolicy(key) {
  if (!key) return null;
  const db = await getAdapter();
  return rowToKey(db.get(`SELECT * FROM apiKeys WHERE key = ?`, [key]));
}

/**
 * Add one usage row to its key's running totals. Called inside
 * saveRequestUsage's transaction so the totals and usageHistory move together.
 * A key that isn't in apiKeys (local mode, a deleted key) updates nothing.
 */
export function addApiKeySpendSync(db, key, cost, timestamp) {
  if (!key || typeof key !== "string") return;
  db.run(
    `UPDATE apiKeys SET spentUsd = COALESCE(spentUsd, 0) + ?, requestCount = COALESCE(requestCount, 0) + 1,
       lastUsedAt = CASE WHEN lastUsedAt IS NULL OR lastUsedAt < ? THEN ? ELSE lastUsedAt END
     WHERE key = ?`,
    [Number(cost) || 0, timestamp, timestamp, key]
  );
}
