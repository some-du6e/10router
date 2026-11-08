// Management keys, their audit log, and which rows each one created.
// Only the sha256 of a key's secret is stored: the secret is returned once, by
// createManagementKey, and can't be read back. See docs/MANAGEMENT_KEYS.md.
import crypto from "node:crypto";
import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";
import { MANAGEMENT_KEY_PREFIX, parseStoredScopes } from "@/shared/utils/managementKey.js";

// Random characters shown after the prefix so a key can be recognised in a list.
const DISPLAY_CHARS = 6;
// The audit log keeps this many rows; older ones are dropped on insert.
export const AUDIT_KEEP = 5000;

export function hashManagementKey(secret) {
  return crypto.createHash("sha256").update(String(secret)).digest("hex");
}

function generateSecret() {
  return `${MANAGEMENT_KEY_PREFIX}${crypto.randomBytes(32).toString("base64url")}`;
}

/** The row as the rest of the app sees it. Never includes the hash. */
function rowToManagementKey(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    keyPrefix: row.keyPrefix,
    scopes: parseStoredScopes(row.scopes),
    isActive: row.isActive === 1 || row.isActive === true,
    expiresAt: row.expiresAt || null,
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt || null,
  };
}

/**
 * @param {{ name: string, scopes: object, expiresAt?: string|null }} input already validated
 * @returns {Promise<{ managementKey: object, secret: string }>} the secret, once
 */
export async function createManagementKey({ name, scopes, expiresAt = null }) {
  const db = await getAdapter();
  const secret = generateSecret();
  const id = uuidv4();
  const createdAt = new Date().toISOString();
  db.run(
    `INSERT INTO managementKeys(id, name, keyHash, keyPrefix, scopes, isActive, expiresAt, createdAt) VALUES(?, ?, ?, ?, ?, 1, ?, ?)`,
    [id, name, hashManagementKey(secret), secret.slice(0, MANAGEMENT_KEY_PREFIX.length + DISPLAY_CHARS), stringifyJson(scopes), expiresAt, createdAt]
  );
  return { managementKey: rowToManagementKey(db.get(`SELECT * FROM managementKeys WHERE id = ?`, [id])), secret };
}

export async function getManagementKeys() {
  const db = await getAdapter();
  return db.all(`SELECT * FROM managementKeys ORDER BY createdAt ASC`).map(rowToManagementKey);
}

export async function getManagementKeyById(id) {
  const db = await getAdapter();
  return rowToManagementKey(db.get(`SELECT * FROM managementKeys WHERE id = ?`, [id]));
}

/** The key whose secret this is, active or not. Null for anything else. */
export async function findManagementKeyBySecret(secret) {
  if (typeof secret !== "string" || !secret.startsWith(MANAGEMENT_KEY_PREFIX)) return null;
  const db = await getAdapter();
  return rowToManagementKey(db.get(`SELECT * FROM managementKeys WHERE keyHash = ?`, [hashManagementKey(secret)]));
}

/** @param {{ name?: string, isActive?: boolean, expiresAt?: string|null, scopes?: object }} data already validated */
export async function updateManagementKey(id, data) {
  const db = await getAdapter();
  const sets = [];
  const params = [];
  if (data.name !== undefined) { sets.push("name = ?"); params.push(data.name); }
  if (data.isActive !== undefined) { sets.push("isActive = ?"); params.push(data.isActive ? 1 : 0); }
  if (data.expiresAt !== undefined) { sets.push("expiresAt = ?"); params.push(data.expiresAt); }
  if (data.scopes !== undefined) { sets.push("scopes = ?"); params.push(stringifyJson(data.scopes)); }
  if (sets.length) db.run(`UPDATE managementKeys SET ${sets.join(", ")} WHERE id = ?`, [...params, id]);
  return getManagementKeyById(id);
}

/** Revoke: the key stops working at once. Rows it created stay, still marked as its. */
export async function deleteManagementKey(id) {
  const db = await getAdapter();
  const res = db.run(`DELETE FROM managementKeys WHERE id = ?`, [id]);
  return (res?.changes ?? 0) > 0;
}

export async function touchManagementKey(id, at = new Date().toISOString()) {
  const db = await getAdapter();
  db.run(`UPDATE managementKeys SET lastUsedAt = ? WHERE id = ?`, [at, id]);
}

// ---- Ownership ---------------------------------------------------------------

const OWNED_TABLES = { clientKey: "apiKeys", providerKey: "providerConnections" };

/** Record that a management key created this client key or provider connection. */
export async function setRowOwner(kind, rowId, managementKeyId) {
  const table = OWNED_TABLES[kind];
  if (!table) throw new Error(`unknown kind ${kind}`);
  const db = await getAdapter();
  db.run(`UPDATE ${table} SET ownerManagementKeyId = ? WHERE id = ?`, [managementKeyId, rowId]);
}

/** Map of row id → owning management key id, for rows a management key created. */
export async function getRowOwners(kind) {
  const table = OWNED_TABLES[kind];
  if (!table) throw new Error(`unknown kind ${kind}`);
  const db = await getAdapter();
  const out = new Map();
  for (const r of db.all(`SELECT id, ownerManagementKeyId FROM ${table} WHERE ownerManagementKeyId IS NOT NULL`)) {
    out.set(r.id, r.ownerManagementKeyId);
  }
  return out;
}

export async function getRowOwner(kind, rowId) {
  const table = OWNED_TABLES[kind];
  if (!table) throw new Error(`unknown kind ${kind}`);
  const db = await getAdapter();
  return db.get(`SELECT ownerManagementKeyId FROM ${table} WHERE id = ?`, [rowId])?.ownerManagementKeyId || null;
}

// ---- Audit log ---------------------------------------------------------------

/**
 * @param {{ managementKeyId: string|null, action: string, targetType?: string|null, targetId?: string|null, detail?: object|null }} entry
 *   detail must not hold a secret; callers pass names, ids and limits only.
 */
export async function addManagementAudit({ managementKeyId, action, targetType = null, targetId = null, detail = null }) {
  const db = await getAdapter();
  db.run(
    `INSERT INTO managementAudit(managementKeyId, action, targetType, targetId, at, detail) VALUES(?, ?, ?, ?, ?, ?)`,
    [managementKeyId || null, action, targetType, targetId, new Date().toISOString(), detail ? stringifyJson(detail) : null]
  );
  db.run(`DELETE FROM managementAudit WHERE id <= (SELECT id FROM managementAudit ORDER BY id DESC LIMIT 1 OFFSET ?)`, [AUDIT_KEEP]);
}

export async function getManagementAudit({ limit = 50, managementKeyId = null } = {}) {
  const db = await getAdapter();
  const n = Math.max(1, Math.min(500, Math.floor(Number(limit) || 50)));
  const rows = managementKeyId
    ? db.all(`SELECT * FROM managementAudit WHERE managementKeyId = ? ORDER BY id DESC LIMIT ?`, [managementKeyId, n])
    : db.all(`SELECT * FROM managementAudit ORDER BY id DESC LIMIT ?`, [n]);
  return rows.map((r) => ({
    id: r.id,
    managementKeyId: r.managementKeyId,
    action: r.action,
    targetType: r.targetType,
    targetId: r.targetId,
    at: r.at,
    detail: parseJson(r.detail, null),
  }));
}
