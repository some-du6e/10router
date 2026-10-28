import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";

const OPTIONAL_FIELDS = [
  "displayName", "email", "globalPriority", "defaultModel",
  "accessToken", "refreshToken", "expiresAt", "tokenType",
  "scope", "projectId", "apiKey", "testStatus",
  "lastTested", "lastError", "lastErrorAt", "rateLimitedUntil", "expiresIn", "errorCode",
  "consecutiveUseCount", "idToken", "lastRefreshAt",
];

// Written by sse/services/auth.js when a key keeps failing auth and is turned
// off. Turning the connection back on, by any path, starts it clean; turning it
// off again keeps its reason unless a new key came with it.
const AUTH_STREAK_FIELDS = [
  "authFailCount", "authFailFirstAt", "authFailLastAt", "authFailModels", "authFailAll401", "authFailSameUpstream",
  "authFailRunCount", "authFailRunStartAt", "authFailBursts",
];
const AUTO_DISABLE_FIELDS = ["autoDisabledAt", "autoDisabledReason", ...AUTH_STREAK_FIELDS];

// authDemote_<model>: sse/services/auth.js's count of a key's 403s on that
// model, and its demotion there once they trip. authDemoteOkAt: when the key
// last served anything while demoted somewhere (only compared with demotedAt).
export const AUTH_DEMOTE_PREFIX = "authDemote_";
export const getAuthDemoteKey = (model) => `${AUTH_DEMOTE_PREFIX}${model}`;

function applyAutoDisableTransition(existing, merged, data) {
  const newKey = String(data.apiKey ?? "").trim();
  const keyChanged = newKey !== "" && newKey !== String(existing.apiKey ?? "").trim();
  // A different key pasted into a connection the router turned off fixes it.
  if (existing.autoDisabledAt && data.isActive === undefined && keyChanged) merged.isActive = true;
  const reEnabled = existing.isActive === false && merged.isActive === true;
  if (reEnabled || keyChanged) {
    // A new key or turning the key back on clears its demotions too.
    for (const k of Object.keys(merged)) if (k.startsWith(AUTH_DEMOTE_PREFIX)) merged[k] = null;
  }
  if (reEnabled) {
    for (const f of AUTO_DISABLE_FIELDS) delete merged[f];
  } else if (data.isActive === false && data.autoDisabledAt === undefined && keyChanged) {
    delete merged.autoDisabledAt;
    delete merged.autoDisabledReason;
  }
  // The old key's failures say nothing about the new one.
  if (keyChanged) for (const f of AUTH_STREAK_FIELDS) delete merged[f];
}

// Read by sse/services/autoCombo.ts to notice its model catalog is stale.
// Bumped on any write that changes what /v1/models lists: connections, model
// aliases, custom and disabled models.
export function bumpConnectionsVersion() {
  global._connectionsVersion = (global._connectionsVersion || 0) + 1;
}

function rowToConn(row) {
  if (!row) return null;
  const extra = parseJson(row.data, {});
  return {
    ...extra,
    id: row.id,
    provider: row.provider,
    authType: row.authType,
    name: row.name,
    email: row.email,
    priority: row.priority,
    isActive: row.isActive === 1 || row.isActive === true,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function connToRow(c) {
  const { id, provider, authType, name, email, priority, isActive, createdAt, updatedAt, ...rest } = c;
  return {
    id,
    provider,
    authType,
    name: name ?? null,
    email: email ?? null,
    priority: priority ?? null,
    isActive: isActive === false ? 0 : 1,
    data: stringifyJson(rest),
    createdAt,
    updatedAt,
  };
}

function upsert(db, c) {
  const r = connToRow(c);
  db.run(
    `INSERT INTO providerConnections(id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       provider=excluded.provider, authType=excluded.authType, name=excluded.name,
       email=excluded.email, priority=excluded.priority, isActive=excluded.isActive,
       data=excluded.data, updatedAt=excluded.updatedAt`,
    [r.id, r.provider, r.authType, r.name, r.email, r.priority, r.isActive, r.data, r.createdAt, r.updatedAt]
  );
}

function deriveConnectionName(data, fallbackName) {
  if (data.provider === "github") {
    return data.providerSpecificData?.githubLogin
      || data.providerSpecificData?.githubEmail
      || data.email
      || data.providerSpecificData?.githubName
      || fallbackName;
  }
  return fallbackName;
}

export async function getProviderConnections(filter = {}) {
  const db = await getAdapter();
  const where = [];
  const params = [];
  if (filter.provider) { where.push("provider = ?"); params.push(filter.provider); }
  if (filter.isActive !== undefined) { where.push("isActive = ?"); params.push(filter.isActive ? 1 : 0); }
  const sql = `SELECT * FROM providerConnections${where.length ? ` WHERE ${where.join(" AND ")}` : ""}`;
  const rows = db.all(sql, params);
  const list = rows.map(rowToConn);
  list.sort((a, b) => (a.priority || 999) - (b.priority || 999));
  return list;
}

export async function getProviderConnectionById(id) {
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM providerConnections WHERE id = ?`, [id]);
  return rowToConn(row);
}

// Internal sync reorder — must be called INSIDE a transaction.
//
// Normalizes priorities to a contiguous 1..N after a DELETE or an explicit
// reorder, so gaps don't accumulate over time.
//
// Deliberately NOT called on insert: a new connection already gets
// MAX(priority)+1, which sorts after every existing row, so the order is
// identical with or without the rewrite. Skipping it there is what makes
// import O(1) per key instead of O(pool) — see createProviderConnection.
function reorderInTx(db, providerId) {
  const list = db.all(`SELECT * FROM providerConnections WHERE provider = ?`, [providerId]).map(rowToConn);
  list.sort((a, b) => {
    const pDiff = (a.priority || 0) - (b.priority || 0);
    if (pDiff !== 0) return pDiff;
    return new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0);
  });
  list.forEach((c, i) => {
    const want = i + 1;
    if ((c.priority || 0) !== want) {
      db.run(`UPDATE providerConnections SET priority = ? WHERE id = ?`, [want, c.id]);
    }
  });
}

export async function createProviderConnection(data) {
  const db = await getAdapter();
  const now = new Date().toISOString();
  let result;

  db.transaction(() => {
    // apikey connections are deduped by name and need only the current max
    // priority, so query for those directly instead of loading the whole pool
    // (O(pool) per key — the other half of the import cost in #4311). The oauth
    // branch below still scans, because its identity rules compare fields
    // inside providerSpecificData and have no single-column equivalent.
    const isApikey = data.authType === "apikey" && !!data.name;
    const all = isApikey
      ? db.all(
          `SELECT * FROM providerConnections WHERE provider = ? AND authType = ? AND name = ?`,
          [data.provider, "apikey", data.name]
        ).map(rowToConn)
      : db.all(`SELECT * FROM providerConnections WHERE provider = ?`, [data.provider]).map(rowToConn);
    const poolSize = isApikey
      ? db.get(`SELECT COUNT(*) AS n FROM providerConnections WHERE provider = ?`, [data.provider])?.n ?? all.length
      : all.length;

    let existing = null;
    if (data.authType === "oauth" && data.email) {
      const incomingUsername = data.providerSpecificData?.username;
      const incomingWs = data.providerSpecificData?.chatgptAccountId;
      existing = all.find(c => {
        if (c.authType !== "oauth" || c.email !== data.email) return false;

        // Codex/OpenAI can issue multiple OAuth grants for the same email.
        // Refresh tokens are rotated single-use; collapsing a new login onto an
        // existing bare-email row overwrites the first account's token pair and
        // makes it look "invalid" after adding a second account. Only update an
        // existing Codex row when both rows expose the same ChatGPT account ID.
        if (data.provider === "codex") {
          const existingWs = c.providerSpecificData?.chatgptAccountId;
          return !!incomingWs && !!existingWs && incomingWs === existingWs;
        }

        // Workspace providers use workspace ID when both sides have it
        const existingWs = c.providerSpecificData?.chatgptAccountId;
        if (incomingWs && existingWs) return incomingWs === existingWs;
        if (incomingWs && !existingWs) return false;
        if (!incomingWs && existingWs) return false;
        // Non-workspace providers: match on (email + username) so cross-IdP
        // accounts don't overwrite each other. Require username on both sides
        // — if only one side has it, treat as a distinct identity rather than
        // collapsing onto the bare-email fallback (which would re-introduce
        // the cross-IdP overwrite).
        const existingUsername = c.providerSpecificData?.username;
        if (incomingUsername && existingUsername) {
          return incomingUsername === existingUsername;
        }
        if (incomingUsername || existingUsername) return false;
        return true;
      });
    } else if (data.authType === "apikey" && data.name) {
      existing = all.find(c => c.authType === "apikey" && c.name === data.name);
    }
    // access_token: never dedup — user manages duplicates manually

    if (existing) {
      if (isApikey && data.allowOverwrite === false) {
        const err = new Error(
          `A connection named "${existing.name}" already exists for provider "${data.provider}". ` +
          `Pass allowOverwrite: true to replace it.`
        );
        err.code = "PROVIDER_NAME_CONFLICT";
        err.existingId = existing.id;
        err.existingName = existing.name;
        throw err;
      }
      const updates = Object.fromEntries(Object.entries(data).filter(([key, value]) => key !== "allowOverwrite" && value !== undefined));
      const merged = { ...existing, ...updates, updatedAt: now };
      // Re-adding or re-logging a key the router turned off means it was fixed.
      if (existing.autoDisabledAt && updates.isActive === undefined) merged.isActive = true;
      applyAutoDisableTransition(existing, merged, updates);
      upsert(db, merged);
      result = merged;
      return;
    }

    let connectionName = data.name || null;
    if (!connectionName && (data.authType === "oauth" || data.authType === "access_token")) {
      connectionName = deriveConnectionName(data, data.email || `Account ${poolSize + 1}`);
    }
    let connectionPriority = data.priority;
    if (!connectionPriority) {
      // MAX(priority)+1 in SQL rather than a reduce over the loaded pool: the
      // apikey path no longer has the whole pool in memory, and the aggregate
      // is served by the index instead of a row scan. #4311
      const maxRow = db.get(`SELECT MAX(priority) AS m FROM providerConnections WHERE provider = ?`, [data.provider]);
      connectionPriority = (maxRow?.m || 0) + 1;
    }

    const conn = {
      id: uuidv4(),
      provider: data.provider,
      authType: data.authType || "oauth",
      name: connectionName,
      priority: connectionPriority,
      isActive: data.isActive !== undefined ? data.isActive : true,
      createdAt: now,
      updatedAt: now,
    };
    for (const f of OPTIONAL_FIELDS) {
      if (data[f] !== undefined && data[f] !== null) conn[f] = data[f];
    }
    if (data.providerSpecificData && Object.keys(data.providerSpecificData).length > 0) {
      conn.providerSpecificData = data.providerSpecificData;
    }
    if (data.email !== undefined) conn.email = data.email;

    upsert(db, conn);
    if (data.priority) reorderInTx(db, data.provider);
    result = conn;
  });

  bumpConnectionsVersion();
  return result;
}

// Critical: OAuth refresh token race — atomic merge inside transaction.
// autoDisable fields are applied only if the connection is still on and another
// connection of its provider is too, decided in the same transaction as the write.
// demote ({ model, from, to, data, probeNow }) replaces the model's demotion
// record `from` with `to`, applies `data`, and makes the demotions on the
// probeNow models due, only if the record is still `from`. liftDemote
// is a model that just succeeded: its record goes, whenever it was written; with
// noteServed, authDemoteOkAt marks the success for the stored records.
// apiKeyUsed is the key a failing request used: if another key has been stored
// since, the request's auth streak fields, autoDisable and demote are dropped.
export async function updateProviderConnection(id, data, { autoDisable = null, demote = null, liftDemote = null, noteServed = false, apiKeyUsed } = {}) {
  const db = await getAdapter();
  let result;
  let servesChanged = false;
  db.transaction(() => {
    const row = db.get(`SELECT * FROM providerConnections WHERE id = ?`, [id]);
    if (!row) { result = null; return; }
    const existing = rowToConn(row);
    const merged = { ...existing, ...data, updatedAt: new Date().toISOString() };
    const staleKey = apiKeyUsed !== undefined && existing.apiKey !== apiKeyUsed;
    if (staleKey) {
      for (const f of AUTH_STREAK_FIELDS) {
        if (f in existing) merged[f] = existing[f];
        else delete merged[f];
      }
    }
    if (autoDisable && !staleKey && existing.isActive && db.get(
      `SELECT 1 FROM providerConnections WHERE provider = ? AND id != ? AND isActive = 1 LIMIT 1`, [existing.provider, id],
    )) Object.assign(merged, autoDisable);
    const demoteKey = demote && getAuthDemoteKey(demote.model);
    if (demote && !staleKey && JSON.stringify(existing[demoteKey] ?? null) === JSON.stringify(demote.from ?? null)) {
      Object.assign(merged, demote.data, { [demoteKey]: demote.to });
      // Other models' demotions to probe right away.
      const now = new Date().toISOString();
      for (const model of demote.probeNow || []) {
        const record = existing[getAuthDemoteKey(model)];
        if (record?.demotedAt && record.nextProbeAt > now) merged[getAuthDemoteKey(model)] = { ...record, nextProbeAt: now };
      }
    }
    if (liftDemote && existing[getAuthDemoteKey(liftDemote)]) merged[getAuthDemoteKey(liftDemote)] = null;
    if (noteServed) merged.authDemoteOkAt = new Date().toISOString();
    applyAutoDisableTransition(existing, merged, data);
    upsert(db, merged);
    if (data.priority !== undefined) reorderInTx(db, existing.provider);
    result = merged;
    // Token refreshes and rate-limit stamps write here constantly; only a
    // change to what the connection serves counts.
    const psdBefore = existing.providerSpecificData || {};
    const psdAfter = merged.providerSpecificData || {};
    servesChanged =
      existing.isActive !== merged.isActive ||
      existing.authType !== merged.authType ||
      psdBefore.prefix !== psdAfter.prefix ||
      psdBefore.baseUrl !== psdAfter.baseUrl ||
      JSON.stringify(psdBefore.enabledModels) !== JSON.stringify(psdAfter.enabledModels);
  });
  if (servesChanged) bumpConnectionsVersion();
  return result;
}

export async function deleteProviderConnection(id) {
  const db = await getAdapter();
  let ok = false;
  db.transaction(() => {
    const row = db.get(`SELECT provider FROM providerConnections WHERE id = ?`, [id]);
    if (!row) return;
    db.run(`DELETE FROM providerConnections WHERE id = ?`, [id]);
    reorderInTx(db, row.provider);
    ok = true;
  });
  if (ok) bumpConnectionsVersion();
  return ok;
}

export async function deleteProviderConnectionsByProvider(providerId) {
  const db = await getAdapter();
  const before = db.get(`SELECT COUNT(*) AS n FROM providerConnections WHERE provider = ?`, [providerId]);
  db.run(`DELETE FROM providerConnections WHERE provider = ?`, [providerId]);
  bumpConnectionsVersion();
  return before?.n || 0;
}

export async function reorderProviderConnections(providerId) {
  const db = await getAdapter();
  db.transaction(() => reorderInTx(db, providerId));
}

export async function cleanupProviderConnections() {
  const db = await getAdapter();
  const fieldsToCheck = [
    "displayName", "email", "globalPriority", "defaultModel",
    "accessToken", "refreshToken", "expiresAt", "tokenType",
    "scope", "projectId", "apiKey", "testStatus",
    "lastTested", "lastError", "lastErrorAt", "rateLimitedUntil", "expiresIn",
    "consecutiveUseCount",
  ];
  let cleaned = 0;
  db.transaction(() => {
    const rows = db.all(`SELECT * FROM providerConnections`);
    for (const row of rows) {
      const conn = rowToConn(row);
      let dirty = false;
      for (const f of fieldsToCheck) {
        if (conn[f] === null || conn[f] === undefined) {
          if (f in conn) { delete conn[f]; cleaned++; dirty = true; }
        }
      }
      if (conn.providerSpecificData && Object.keys(conn.providerSpecificData).length === 0) {
        delete conn.providerSpecificData;
        cleaned++;
        dirty = true;
      }
      if (dirty) upsert(db, conn);
    }
  });
  return cleaned;
}
