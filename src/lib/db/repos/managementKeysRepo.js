// Management keys, their audit log, and which rows each one created.
// Only the sha256 of a key's secret is stored: the secret is returned once, by
// createScopedManagementKey, and can't be read back. See docs/MANAGEMENT_KEYS.md.
// (Not to be confused with the usage hub's single key in src/lib/usageHub/auth.js.)
import crypto from "node:crypto";
import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";
import { rowToKey, numberOrNull, toAllowedModelsColumn, updateApiKeyInTx } from "./apiKeysRepo.js";
import { generateApiKeyWithMachine } from "@/shared/utils/apiKey.js";
import { MANAGEMENT_KEY_PREFIX, parseStoredScopes } from "@/shared/utils/managementKey.js";

// Random characters shown after the prefix so a key can be recognised in a list.
const DISPLAY_CHARS = 6;
// The audit log keeps this many rows per pool: each management key's own
// actions and refusals apart (so one key can only evict its own history), and
// the dashboard's changes in a pool of their own.
export const AUDIT_KEEP_PER_KEY = 1000;
export const AUDIT_KEEP_DENIED_PER_KEY = 200;
// Deletes are kept apart and longer, so a run of renames can't trim away the
// record of what a key removed.
export const AUDIT_KEEP_DELETES_PER_KEY = 5000;
export const AUDIT_KEEP_DASHBOARD = 2000;
// Longest audit detail, as JSON.
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

/** Is this management key still there and on? Checked inside the write that claims a row for it. */
function managementKeyActiveInTx(db, managementKeyId) {
  const row = db.get(`SELECT isActive, expiresAt FROM managementKeys WHERE id = ?`, [managementKeyId]);
  if (!row || !(row.isActive === 1 || row.isActive === true)) return false;
  return !row.expiresAt || new Date(row.expiresAt).getTime() > Date.now();
}

/**
 * Create a client key with its limits and owner in one insert, so it never
 * exists, even for a moment, without them. Null when the management key was
 * revoked or turned off meanwhile: then nothing is created.
 * @param {{ name: string, machineId: string, limits: { budgetUsd?: number|null, allowedModels?: string[]|null, expiresAt?: string|null }, ownerId: string }} input
 */
export async function createOwnedApiKey({ name, machineId, limits, ownerId }) {
  if (!machineId) throw new Error("machineId is required");
  const db = await getAdapter();
  const id = uuidv4();
  const { key } = generateApiKeyWithMachine(machineId);
  const expiresAt = limits.expiresAt || null;
  let created = null;
  db.transaction(() => {
    if (!managementKeyActiveInTx(db, ownerId)) return;
    db.run(
      `INSERT INTO apiKeys(id, key, name, machineId, isActive, createdAt, budgetUsd, allowedModels, expiresAt, ownerManagementKeyId, expiresAtSetBy)
       VALUES(?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`,
      [id, key, name, machineId, new Date().toISOString(), numberOrNull(limits.budgetUsd), toAllowedModelsColumn(limits.allowedModels),
        expiresAt, ownerId, expiresAt ? ownerId : null]
    );
    created = rowToKey(db.get(`SELECT * FROM apiKeys WHERE id = ?`, [id]));
  });
  return created;
}

const sameInstant = (a, b) => (a ? new Date(a).getTime() : null) === (b ? new Date(b).getTime() : null);

/**
 * Who owns the key's on/off state and expiry after `actor` applies `update`.
 * "dashboard" is never replaced by a management key, and a no-op change (off
 * to off, the same expiry) moves nothing, so a management key can't take over
 * the dashboard's choice by repeating it.
 */
export function nextKeyActors(existing, update, actor) {
  let disabledBy = existing.disabledBy || null;
  let expiresAtSetBy = existing.expiresAtSetBy || null;
  const isDashboard = actor === DASHBOARD_ACTOR;
  // A key off, or with an expiry, from before this was recorded is the dashboard's.
  if (existing.isActive === false && !disabledBy) disabledBy = DASHBOARD_ACTOR;
  if (existing.expiresAt && !expiresAtSetBy) expiresAtSetBy = DASHBOARD_ACTOR;

  if (update.isActive !== undefined && update.isActive !== existing.isActive) {
    if (update.isActive) disabledBy = null;
    else if (isDashboard || disabledBy !== DASHBOARD_ACTOR) disabledBy = actor;
  } else if (isDashboard && update.isActive === false) {
    // The dashboard turning off a key a management key had turned off takes it over.
    disabledBy = DASHBOARD_ACTOR;
  }

  if (update.expiresAt !== undefined && !sameInstant(update.expiresAt, existing.expiresAt)) {
    if (!update.expiresAt) expiresAtSetBy = null;
    else if (isDashboard || expiresAtSetBy !== DASHBOARD_ACTOR) expiresAtSetBy = actor;
  }
  return { disabledBy, expiresAtSetBy };
}

/**
 * Why a management key may not make this change to the key's on/off state or
 * expiry, or null. A key the dashboard turned off stays off, and an expiry the
 * dashboard set can only be moved earlier. A key that is off (or has an
 * expiry) with no recorded actor predates the record, so it counts as the dashboard's.
 */
export function dashboardChoiceViolation(existing, update) {
  if (update.isActive === true && existing.isActive === false) {
    const by = existing.disabledBy || DASHBOARD_ACTOR;
    if (by === DASHBOARD_ACTOR) return "this key was turned off in the dashboard; only the dashboard can turn it back on";
  }
  if (update.expiresAt !== undefined && existing.expiresAt) {
    const by = existing.expiresAtSetBy || DASHBOARD_ACTOR;
    const later = !update.expiresAt || new Date(update.expiresAt).getTime() > new Date(existing.expiresAt).getTime();
    if (by === DASHBOARD_ACTOR && later) return "this key's expiry was set in the dashboard; it can only be moved earlier";
  }
  return null;
}

/**
 * Update a client key and record who changed its on/off state and expiry, in
 * one transaction. `actor` is "dashboard" or a management key id. For a
 * management key, the key's own state and the dashboard's choices are checked
 * again against the row as it is inside that transaction, so an admin pausing
 * the key (or setting its expiry) between the caller's read and this write wins.
 *
 * @returns {Promise<{ key: object|null, status?: number, error?: string }>}
 */
export async function updateApiKeyAs(id, update, actor) {
  const db = await getAdapter();
  let out = { key: null };
  db.transaction(() => {
    const before = rowToKey(db.get(`SELECT * FROM apiKeys WHERE id = ?`, [id]));
    if (!before) return;
    if (actor !== DASHBOARD_ACTOR) {
      if (!managementKeyActiveInTx(db, actor)) { out = { key: null, status: 401, error: "This management key was revoked or turned off" }; return; }
      const refusal = dashboardChoiceViolation(before, update);
      if (refusal) { out = { key: null, status: 403, error: refusal }; return; }
    }
    updateApiKeyInTx(db, id, update);
    const { disabledBy, expiresAtSetBy } = nextKeyActors(before, update, actor);
    db.run(`UPDATE apiKeys SET disabledBy = ?, expiresAtSetBy = ? WHERE id = ?`, [disabledBy, expiresAtSetBy, id]);
    out = { key: rowToKey(db.get(`SELECT * FROM apiKeys WHERE id = ?`, [id])) };
  });
  return out;
}

// ---- Ownership ---------------------------------------------------------------

const OWNED_TABLES = { clientKey: "apiKeys", providerKey: "providerConnections" };

function ownedTable(kind) {
  const table = OWNED_TABLES[kind];
  if (!table) throw new Error(`unknown kind ${kind}`);
  return table;
}

/**
 * Record that a management key created this row, if the key is still there
 * and on, in one transaction. False when it isn't: the caller removes the row.
 */
export async function claimRowForManagementKey(kind, rowId, managementKeyId) {
  const db = await getAdapter();
  let claimed = false;
  db.transaction(() => {
    if (!managementKeyActiveInTx(db, managementKeyId)) return;
    db.run(`UPDATE ${ownedTable(kind)} SET ownerManagementKeyId = ? WHERE id = ?`, [managementKeyId, rowId]);
    claimed = true;
  });
  return claimed;
}

/** Record an owner without checking the management key (tests set up rows with it). */
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

/** The rows management keys created, with what the dashboard lists for each. Uses the owner index. */
export async function getOwnedRows(kind) {
  const db = await getAdapter();
  const cols = kind === "providerKey" ? "id, provider, name, isActive, ownerManagementKeyId" : "id, name, isActive, ownerManagementKeyId";
  return db.all(`SELECT ${cols} FROM ${ownedTable(kind)} WHERE ownerManagementKeyId IS NOT NULL ORDER BY rowid`)
    .map((r) => ({ ...r, isActive: r.isActive === 1 || r.isActive === true }));
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

export const AUDIT_POOLS = { ok: "ok", denied: "denied", delete: "delete", dashboard: "dashboard" };
const PER_KEY_KEEP = { ok: AUDIT_KEEP_PER_KEY, denied: AUDIT_KEEP_DENIED_PER_KEY, delete: AUDIT_KEEP_DELETES_PER_KEY };

function truncate(value, max) {
  const s = String(value);
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** Lists cut to their first 3 entries plus a count, strings to 300 characters. */
function compacted(detail) {
  const out = {};
  for (const [k, v] of Object.entries(detail)) {
    if (v === null || v === undefined || typeof v === "number" || typeof v === "boolean") out[k] = v ?? null;
    else if (Array.isArray(v)) {
      out[k] = v.slice(0, 3).map((x) => truncate(x, 100));
      if (v.length > 3) out[`${k}Count`] = v.length;
    } else out[k] = truncate(typeof v === "object" ? JSON.stringify(v) : v, 300);
  }
  return out;
}

/** Lists replaced by their counts, strings cut short: what a success detail falls back to over the cap. */
function counted(detail) {
  const out = {};
  for (const [k, v] of Object.entries(detail)) {
    if (Array.isArray(v)) out[`${k}Count`] = v.length;
    else if (typeof v === "string") out[k] = truncate(v, 300);
    else if (v && typeof v === "object") out[k] = truncate(JSON.stringify(v), 300);
    else out[k] = v ?? null;
  }
  return out;
}

/**
 * A detail as stored, always under AUDIT_DETAIL_MAX. A refusal's is compacted
 * (an attacker picks its content). A success keeps its full lists while they
 * fit, and falls back to counts when they don't.
 */
export function compactAuditDetail(detail, { denied = false } = {}) {
  if (!detail || typeof detail !== "object") return null;
  const tries = denied ? [compacted(detail)] : [detail, counted(detail)];
  for (const t of tries) {
    const json = stringifyJson(t);
    if (json.length <= AUDIT_DETAIL_MAX) return json;
  }
  return stringifyJson({ truncated: true });
}

/**
 * @param {{ managementKeyId: string|null, action: string, targetType?: string|null, targetId?: string|null, detail?: object|null, pool?: "ok"|"denied"|"dashboard" }} entry
 *   detail must not hold a secret; callers pass names, ids and limits only.
 */
export async function addManagementAudit({ managementKeyId, action, targetType = null, targetId = null, detail = null, pool = AUDIT_POOLS.ok }) {
  if (!Object.values(AUDIT_POOLS).includes(pool)) throw new Error(`unknown audit pool ${pool}`);
  const db = await getAdapter();
  db.run(
    `INSERT INTO managementAudit(managementKeyId, action, targetType, targetId, at, detail, pool) VALUES(?, ?, ?, ?, ?, ?, ?)`,
    [managementKeyId || null, action, targetType, targetId, new Date().toISOString(), compactAuditDetail(detail, { denied: pool === AUDIT_POOLS.denied }), pool]
  );
  // Trim only the pool (and, for a key's own rows, only that key) the row went into.
  if (pool === AUDIT_POOLS.dashboard) {
    db.run(
      `DELETE FROM managementAudit WHERE pool = ? AND id <= (SELECT id FROM managementAudit WHERE pool = ? ORDER BY id DESC LIMIT 1 OFFSET ?)`,
      [pool, pool, AUDIT_KEEP_DASHBOARD]
    );
  } else {
    db.run(
      `DELETE FROM managementAudit WHERE pool = ? AND managementKeyId IS ? AND id <= (SELECT id FROM managementAudit WHERE pool = ? AND managementKeyId IS ? ORDER BY id DESC LIMIT 1 OFFSET ?)`,
      [pool, managementKeyId || null, pool, managementKeyId || null, PER_KEY_KEEP[pool]]
    );
  }
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
    pool: r.pool,
    denied: r.pool === AUDIT_POOLS.denied,
    detail: parseJson(r.detail, null),
  }));
}
