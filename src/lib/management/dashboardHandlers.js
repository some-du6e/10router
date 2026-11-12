// The dashboard's side of management keys (/api/management-keys, behind the
// session login): create, edit, revoke, and see what each key created and did.
// This is the only place management keys can be created or changed.
import {
  createScopedManagementKey, getManagementKeys, getManagementKeyById, updateManagementKey, deleteManagementKey,
  getManagementAudit, addManagementAudit, getOwnedRows, getRowsOwnedBy, deleteApiKey,
  deleteProviderConnection, getProviderNodes, getSettings,
} from "@/lib/db/index.js";
import { getDashboardAuthSession } from "@/lib/auth/dashboardSession";
import { needsSetup } from "@/lib/auth/setupState";
import { normalizeManagementScopes, normalizeManagementKeyName } from "@/shared/utils/managementKey.js";
import { parseKeyLimitsInput } from "@/shared/utils/apiKeyLimits.js";
import { AI_PROVIDERS } from "@/shared/constants/providers";
import { canonicalProviderId } from "./policy.js";
import { serializeManagementKey } from "./serialize.js";
import { json, fail, readBody } from "./http.js";

// How much the dashboard list returns: recent audit entries, and rows named
// per management key (the counts are always complete).
export const DASHBOARD_AUDIT_LIMIT = 30;
export const DASHBOARD_CREATED_LIMIT = 50;
const CREATE_FIELDS = new Set(["name", "scopes", "expiresAt"]);
const PATCH_FIELDS = new Set(["name", "isActive", "expiresAt", "scopes"]);

function readCookie(request, name) {
  const fromNext = request.cookies?.get?.(name)?.value;
  if (fromNext) return fromNext;
  for (const part of (request.headers.get("cookie") || "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

/**
 * The same rule the proxy applies to dashboard APIs, checked again in the
 * route: minting a management key must not rest on the proxy alone.
 */
async function dashboardSessionOk(request) {
  const session = await getDashboardAuthSession(readCookie(request, "auth_token"));
  if (session && session.pwChange !== true) return true;
  const settings = await getSettings().catch(() => null);
  return !!settings && settings.requireLogin === false && !(await needsSetup(settings));
}

async function withSession(request, fn) {
  if (!(await dashboardSessionOk(request))) return fail(401, "Unauthorized");
  return fn();
}

function parseExpiry(raw) {
  const { data, errors } = parseKeyLimitsInput({ expiresAt: raw });
  return errors.length ? { error: errors[0] } : { expiresAt: data.expiresAt ?? null };
}

/** Scopes from the dashboard, with every provider id checked against the registry and the custom nodes. */
async function parseScopes(raw) {
  const { scopes, errors } = normalizeManagementScopes(raw);
  if (errors.length) return { error: errors.join("; ") };
  const nodes = await getProviderNodes().catch(() => []);
  const known = new Set([...Object.keys(AI_PROVIDERS), ...nodes.map((n) => n.id)].map((id) => String(id).toLowerCase()));
  const hostEndpoints = Object.keys(scopes.providerKeys.baseUrlHosts || {});
  for (const list of [scopes.clientKeys.providers, scopes.providerKeys.providers, hostEndpoints]) {
    for (const p of list || []) {
      if (!known.has(canonicalProviderId(p))) return { error: `Unknown provider "${p}"` };
    }
  }
  return { scopes };
}

async function dashboardAudit(managementKeyId, action, detail) {
  try {
    await addManagementAudit({ managementKeyId, action, targetType: "managementKey", targetId: managementKeyId, detail: { by: "dashboard", ...detail }, pool: "dashboard" });
  } catch {}
}

function emptyCreated() {
  return { clientKeys: [], providerKeys: [], clientKeyCount: 0, providerKeyCount: 0 };
}

export function listManagementKeys(request) {
  return withSession(request, async () => {
    // Only rows a management key made, through the owner indexes.
    const [keys, ownedClientKeys, ownedProviderKeys, audit] = await Promise.all([
      getManagementKeys(), getOwnedRows("clientKey"), getOwnedRows("providerKey"),
      getManagementAudit({ limit: DASHBOARD_AUDIT_LIMIT }),
    ]);
    // Grouped by owner id, including owners that have since been revoked.
    const created = new Map();
    const group = (id) => {
      if (!created.has(id)) created.set(id, emptyCreated());
      return created.get(id);
    };
    for (const k of ownedClientKeys) {
      const g = group(k.ownerManagementKeyId);
      g.clientKeyCount++;
      if (g.clientKeys.length < DASHBOARD_CREATED_LIMIT) g.clientKeys.push({ id: k.id, name: k.name, isActive: k.isActive });
    }
    for (const c of ownedProviderKeys) {
      const g = group(c.ownerManagementKeyId);
      g.providerKeyCount++;
      if (g.providerKeys.length < DASHBOARD_CREATED_LIMIT) g.providerKeys.push({ id: c.id, provider: c.provider, name: c.name, isActive: c.isActive });
    }
    const live = new Set(keys.map((k) => k.id));
    return json({
      managementKeys: keys.map((k) => ({ ...serializeManagementKey(k), created: created.get(k.id) || emptyCreated() })),
      // Rows made by keys that were revoked without deleting them.
      orphans: [...created].filter(([id]) => !live.has(id)).map(([id, rows]) => ({ managementKeyId: id, ...rows })),
      audit,
    });
  });
}

export function createManagementKeyFromDashboard(request) {
  return withSession(request, async () => {
    const { body, error } = await readBody(request, CREATE_FIELDS);
    if (error) return error;
    const name = normalizeManagementKeyName(body.name);
    if (name.error) return fail(400, name.error);
    const scopes = await parseScopes(body.scopes);
    if (scopes.error) return fail(400, scopes.error);
    const expiry = parseExpiry(body.expiresAt ?? null);
    if (expiry.error) return fail(400, expiry.error);
    const { managementKey, secret } = await createScopedManagementKey({ name: name.name, scopes: scopes.scopes, expiresAt: expiry.expiresAt });
    await dashboardAudit(managementKey.id, "management_key.create", { name: managementKey.name });
    // The secret is shown this once; only its hash is kept.
    return json({ managementKey: serializeManagementKey(managementKey), secret }, 201);
  });
}

export function updateManagementKeyFromDashboard(request, id) {
  return withSession(request, async () => {
    const existing = await getManagementKeyById(id);
    if (!existing) return fail(404, "Management key not found");
    const { body, error } = await readBody(request, PATCH_FIELDS);
    if (error) return error;
    const update = {};
    if (body.name !== undefined) {
      const name = normalizeManagementKeyName(body.name);
      if (name.error) return fail(400, name.error);
      update.name = name.name;
    }
    if (body.isActive !== undefined) {
      if (typeof body.isActive !== "boolean") return fail(400, "isActive must be true or false");
      update.isActive = body.isActive;
    }
    if (body.expiresAt !== undefined) {
      const expiry = parseExpiry(body.expiresAt);
      if (expiry.error) return fail(400, expiry.error);
      update.expiresAt = expiry.expiresAt;
    }
    if (body.scopes !== undefined) {
      const scopes = await parseScopes(body.scopes);
      if (scopes.error) return fail(400, scopes.error);
      update.scopes = scopes.scopes;
    }
    const changed = Object.keys(update).filter((f) => JSON.stringify(update[f] ?? null) !== JSON.stringify(existing[f] ?? null));
    if (!changed.length) return json({ managementKey: serializeManagementKey(existing) });
    const saved = await updateManagementKey(id, update);
    await dashboardAudit(id, "management_key.update", { changed });
    return json({ managementKey: serializeManagementKey(saved) });
  });
}

/**
 * Revoke a management key. With ?deleteCreated=1, also delete every client key
 * and provider key it created. That works for a key revoked earlier too, so
 * its leftover rows can still be cleaned up.
 */
export function revokeManagementKeyFromDashboard(request, id) {
  return withSession(request, async () => {
    const deleteCreated = ["1", "true"].includes(new URL(request.url).searchParams.get("deleteCreated") || "");
    // The key goes first: a create still in flight then fails its claim (and
    // is undone) instead of leaving a row after the sweep below.
    const existing = await getManagementKeyById(id);
    if (existing) await deleteManagementKey(id);
    const clientIds = deleteCreated ? await getRowsOwnedBy("clientKey", id) : [];
    const providerIds = deleteCreated ? await getRowsOwnedBy("providerKey", id) : [];
    if (!existing && !clientIds.length && !providerIds.length) return fail(404, "Management key not found");
    for (const cid of clientIds) await deleteApiKey(cid);
    for (const pid of providerIds) await deleteProviderConnection(pid);
    await dashboardAudit(id, deleteCreated ? "management_key.revoke_and_delete" : "management_key.revoke", {
      name: existing?.name ?? null, deletedClientKeys: clientIds.length, deletedProviderKeys: providerIds.length,
    });
    return json({ deleted: !!existing, id, deletedClientKeys: clientIds.length, deletedProviderKeys: providerIds.length });
  });
}
