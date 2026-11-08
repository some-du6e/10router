// Management keys, their audit log, and which rows each one created.
// Only the sha256 of a key's secret is stored: the secret is returned once, by
// createScopedManagementKey, and can't be read back. See docs/MANAGEMENT_KEYS.md.
// (Not to be confused with the usage hub's single key in src/lib/usageHub/auth.js.)
import crypto from "node:crypto";
import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";
import { rowToKey, numberOrNull, toAllowedModelsColumn } from "./apiKeysRepo.js";
import { generateApiKeyWithMachine } from "@/shared/utils/apiKey";
import { MANAGEMENT_KEY_PREFIX, parseStoredScopes } from "@/shared/utils/managementKey.js";

// Random characters shown after the prefix so a key can be recognised in a list.
const DISPLAY_CHARS = 6;
// The audit log keeps this many rows of each kind. Refusals are counted apart,
// so a flood of refused requests never pushes out what keys actually did.
export const AUDIT_KEEP = 5000;
export const AUDIT_KEEP_DENIED = 1000;
// Longest audit detail, as JSON. A longer one is replaced by a stub.
export const AUDIT_DETAIL_MAX = 2048;

export const DASHBOARD_ACTOR = "dashboard";

export function hashScopedManagementKey(secret) {
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
export async function createScopedManagementKey({ name, scopes, expiresAt = null }) {
  const db = await getAdapter();
  const secret = generateSecret();
  const id = uuidv4();
  const createdAt = new Date().toISOString();
  db.run(
    `INSERT INTO managementKeys(id, name, keyHash, keyPrefix, scopes, isActive, expiresAt, createdAt) VALUES(?, ?, ?, ?, ?, 1, ?, ?)`,
    [id, name, hashScopedManagementKey(secret), secret.slice(0, MANAGEMENT_KEY_PREFIX.length + DISPLAY_CHARS), stringifyJson(scopes), expiresAt, createdAt]
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
  return rowToManagementKey(db.get(`SELECT * FROM managementKeys WHERE keyHash = ?`, [hashScopedManagementKey(secret)]));
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

/** Revoke: the key stops working at once. Rows it created keep its id as their owner. */
export async function deleteManagementKey(id) {
  const db = await getAdapter();
  const res = db.run(`DELETE FROM managementKeys WHERE id = ?`, [id]);
  return (res?.changes ?? 0) > 0;
}

export async function touchManagementKey(id, at = new Date().toISOString()) {
  const db = await getAdapter();
  db.run(`UPDATE managementKeys SET lastUsedAt = ? WHERE id = ?`, [at, id]);
}

// ---- Client keys made by a management key -----------------------------------

/**
 * Create a client key with its limits and owner in one insert, so it never
 * exists, even for a moment, without them.
 * @param {{ name: string, machineId: string, limits: { budgetUsd?: number|null, allowedModels?: string[]|null, expiresAt?: string|null }, ownerId: string }} input
 */
export async function createOwnedApiKey({ name, machineId, limits, ownerId }) {
  if (!machineId) throw new Error("machineId is required");
  const db = await getAdapter();
  const id = uuidv4();
  const { key } = generateApiKeyWithMachine(machineId);
  const expiresAt = limits.expiresAt || null;
  db.run(
    `INSERT INTO apiKeys(id, key, name, machineId, isActive, createdAt, budgetUsd, allowedModels, expiresAt, ownerManagementKeyId, expiresAtSetBy)
     VALUES(?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`,
    [id, key, name, machineId, new Date().toISOString(), numberOrNull(limits.budgetUsd), toAllowedModelsColumn(limits.allowedModels),
      expiresAt, ownerId, expiresAt ? ownerId : null]
  );
  return rowToKey(db.get(`SELECT * FROM apiKeys WHERE id = ?`, [id]));
}

/**
 * Record who turned a client key off and who set its expiry, after a change by
 * `actor` ("dashboard" or a management key id).
 */
export async function recordApiKeyActor(id, { isActive, expiresAt }, actor) {
  const db = await getAdapter();
  if (isActive !== undefined) db.run(`UPDATE apiKeys SET disabledBy = ? WHERE id = ?`, [isActive ? null : actor, id]);
  if (expiresAt !== undefined) db.run(`UPDATE apiKeys SET expiresAtSetBy = ? WHERE id = ?`, [expiresAt ? actor : null, id]);
}

// ---- Ownership ---------------------------------------------------------------

const OWNED_TABLES = { clientKey: "apiKeys", providerKey: "providerConnections" };

function ownedTable(kind) {
  const table = OWNED_TABLES[kind];
  if (!table) throw new Error(`unknown kind ${kind}`);
  return table;
}

/** Record that a management key created this client key or provider connection. */
export async function setRowOwner(kind, rowId, managementKeyId) {
  const db = await getAdapter();
  db.run(`UPDATE ${ownedTable(kind)} SET ownerManagementKeyId = ? WHERE id = ?`, [managementKeyId, rowId]);
}

/** Map of row id → owning management key id, for rows a management key created. */
export async function getRowOwners(kind) {
  const db = await getAdapter();
  const out = new Map();
  for (const r of db.all(`SELECT id, ownerManagementKeyId FROM ${ownedTable(kind)} WHERE ownerManagementKeyId IS NOT NULL`)) {
    out.set(r.id, r.ownerManagementKeyId);
  }
  return out;
}

export async function getRowOwner(kind, rowId) {
  const db = await getAdapter();
  return db.get(`SELECT ownerManagementKeyId FROM ${ownedTable(kind)} WHERE id = ?`, [rowId])?.ownerManagementKeyId || null;
}

/** Ids of the rows a management key created, whether or not the key still exists. */
export async function getRowsOwnedBy(kind, managementKeyId) {
  const db = await getAdapter();
  return db.all(`SELECT id FROM ${ownedTable(kind)} WHERE ownerManagementKeyId = ?`, [managementKeyId]).map((r) => r.id);
}

// ---- Audit log ---------------------------------------------------------------

function truncate(value, max) {
  const s = String(value);
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** A detail as stored: strings and lists cut short, and the whole thing capped. */
export function compactAuditDetail(detail) {
  if (!detail || typeof detail !== "object") return null;
  const out = {};
  for (const [k, v] of Object.entries(detail)) {
    if (v === null || v === undefined || typeof v === "number" || typeof v === "boolean") out[k] = v ?? null;
    else if (Array.isArray(v)) {
      out[k] = v.slice(0, 3).map((x) => truncate(x, 100));
      if (v.length > 3) out[`${k}Count`] = v.length;
    } else out[k] = truncate(typeof v === "object" ? JSON.stringify(v) : v, 300);
  }
  const json = stringifyJson(out);
  return json.length <= AUDIT_DETAIL_MAX ? json : stringifyJson({ truncated: true, bytes: json.length });
}

/**
 * @param {{ managementKeyId: string|null, action: string, targetType?: string|null, targetId?: string|null, detail?: object|null, denied?: boolean }} entry
 *   detail must not hold a secret; callers pass names, ids and limits only.
 */
export async function addManagementAudit({ managementKeyId, action, targetType = null, targetId = null, detail = null, denied = false }) {
  const db = await getAdapter();
  const flag = denied ? 1 : 0;
  db.run(
    `INSERT INTO managementAudit(managementKeyId, action, targetType, targetId, at, detail, denied) VALUES(?, ?, ?, ?, ?, ?, ?)`,
    [managementKeyId || null, action, targetType, targetId, new Date().toISOString(), compactAuditDetail(detail), flag]
  );
  db.run(
    `DELETE FROM managementAudit WHERE denied = ? AND id <= (SELECT id FROM managementAudit WHERE denied = ? ORDER BY id DESC LIMIT 1 OFFSET ?)`,
    [flag, flag, denied ? AUDIT_KEEP_DENIED : AUDIT_KEEP]
  );
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
    denied: r.denied === 1,
    detail: parseJson(r.detail, null),
  }));
}
