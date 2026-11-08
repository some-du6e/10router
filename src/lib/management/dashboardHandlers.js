// The dashboard's side of management keys (/api/management-keys, behind the
// session login): create, edit, revoke, and see what each key created and did.
// This is the only place management keys can be created or changed.
import {
  createManagementKey, getManagementKeys, getManagementKeyById, updateManagementKey, deleteManagementKey,
  getManagementAudit, addManagementAudit, getRowOwners, getApiKeys, getProviderConnections, getProviderNodes,
} from "@/lib/db/index.js";
import { normalizeManagementScopes, normalizeManagementKeyName } from "@/shared/utils/managementKey.js";
import { parseKeyLimitsInput } from "@/shared/utils/apiKeyLimits.js";
import { AI_PROVIDERS } from "@/shared/constants/providers";
import { canonicalProviderId } from "./policy.js";
import { serializeManagementKey } from "./serialize.js";

function json(body, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

async function readBody(request) {
  const body = await request.json().catch(() => undefined);
  return body && typeof body === "object" && !Array.isArray(body) ? body : null;
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
  for (const list of [scopes.clientKeys.providers, scopes.providerKeys.providers]) {
    for (const p of list || []) {
      if (!known.has(canonicalProviderId(p))) return { error: `Unknown provider "${p}"` };
    }
  }
  return { scopes };
}

async function dashboardAudit(managementKeyId, action, detail) {
  try {
    await addManagementAudit({ managementKeyId, action, targetType: "managementKey", targetId: managementKeyId, detail: { by: "dashboard", ...detail } });
  } catch {}
}

export async function listManagementKeys() {
  const [keys, clientOwners, providerOwners, apiKeys, connections, audit] = await Promise.all([
    getManagementKeys(), getRowOwners("clientKey"), getRowOwners("providerKey"),
    getApiKeys(), getProviderConnections(), getManagementAudit({ limit: 50 }),
  ]);
  const created = new Map(keys.map((k) => [k.id, { clientKeys: [], providerKeys: [] }]));
  for (const k of apiKeys) {
    const owner = clientOwners.get(k.id);
    if (owner && created.has(owner)) created.get(owner).clientKeys.push({ id: k.id, name: k.name, isActive: k.isActive });
  }
  for (const c of connections) {
    const owner = providerOwners.get(c.id);
    if (owner && created.has(owner)) created.get(owner).providerKeys.push({ id: c.id, provider: c.provider, name: c.name, isActive: c.isActive });
  }
  return json({
    managementKeys: keys.map((k) => ({ ...serializeManagementKey(k), created: created.get(k.id) })),
    audit,
  });
}

export async function createManagementKeyFromDashboard(request) {
  const body = await readBody(request);
  if (!body) return json({ error: "Body must be a JSON object" }, 400);
  const name = normalizeManagementKeyName(body.name);
  if (name.error) return json({ error: name.error }, 400);
  const scopes = await parseScopes(body.scopes);
  if (scopes.error) return json({ error: scopes.error }, 400);
  const expiry = parseExpiry(body.expiresAt ?? null);
  if (expiry.error) return json({ error: expiry.error }, 400);
  const { managementKey, secret } = await createManagementKey({ name: name.name, scopes: scopes.scopes, expiresAt: expiry.expiresAt });
  await dashboardAudit(managementKey.id, "management_key.create", { name: managementKey.name });
  // The secret is shown this once; only its hash is kept.
  return json({ managementKey: serializeManagementKey(managementKey), secret }, 201);
}

export async function updateManagementKeyFromDashboard(request, id) {
  const existing = await getManagementKeyById(id);
  if (!existing) return json({ error: "Management key not found" }, 404);
  const body = await readBody(request);
  if (!body) return json({ error: "Body must be a JSON object" }, 400);
  const update = {};
  if (body.name !== undefined) {
    const name = normalizeManagementKeyName(body.name);
    if (name.error) return json({ error: name.error }, 400);
    update.name = name.name;
  }
  if (body.isActive !== undefined) {
    if (typeof body.isActive !== "boolean") return json({ error: "isActive must be true or false" }, 400);
    update.isActive = body.isActive;
  }
  if (body.expiresAt !== undefined) {
    const expiry = parseExpiry(body.expiresAt);
    if (expiry.error) return json({ error: expiry.error }, 400);
    update.expiresAt = expiry.expiresAt;
  }
  if (body.scopes !== undefined) {
    const scopes = await parseScopes(body.scopes);
    if (scopes.error) return json({ error: scopes.error }, 400);
    update.scopes = scopes.scopes;
  }
  const saved = await updateManagementKey(id, update);
  await dashboardAudit(id, "management_key.update", { changed: Object.keys(update) });
  return json({ managementKey: serializeManagementKey(saved) });
}

export async function revokeManagementKeyFromDashboard(id) {
  const existing = await getManagementKeyById(id);
  if (!existing || !(await deleteManagementKey(id))) return json({ error: "Management key not found" }, 404);
  await dashboardAudit(id, "management_key.revoke", { name: existing.name });
  return json({ deleted: true, id });
}
