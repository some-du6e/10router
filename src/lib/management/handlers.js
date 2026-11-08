// The management API: what a management key can do with client keys and
// provider keys. Route files under src/app/api/management/v1 call these.
// Every handler authenticates the key itself (the dashboard guard has already
// checked it too), stays inside the key's scopes, and returns rows through
// serialize.js only. There is deliberately no handler for management keys
// themselves: those are created, edited and listed in the dashboard alone.
// See docs/MANAGEMENT_KEYS.md.
import crypto from "node:crypto";
import {
  getApiKeys, getApiKeyById, createApiKey, updateApiKey, deleteApiKey,
  getProviderConnections, getProviderConnectionById, deleteProviderConnection,
  touchManagementKey, setRowOwner, getRowOwners, getRowOwner, addManagementAudit,
} from "@/lib/db/index.js";
import { getConsistentMachineId } from "@/shared/utils/machineId";
import { parseKeyLimitsInput } from "@/shared/utils/apiKeyLimits.js";
import { normalizeProviderId } from "@/lib/providerNormalization";
import { authenticateManagementKey } from "./auth.js";
import { clientKeyScopeViolation, clientKeyVisible, providerInScope, providerKeyVisible } from "./policy.js";
import { serializeClientKey, serializeProviderKey, serializeManagementKey } from "./serialize.js";

const MAX_NAME_LENGTH = 120;
// Provider-specific fields a management key may set. URL fields (baseUrl,
// azureEndpoint, proxies) are left out: they decide where the gateway sends a
// key, which is the dashboard's call.
const PROVIDER_DATA_FIELDS = new Set(["accountId", "region", "deployment", "organization", "apiVersion"]);
const MAX_PROVIDER_DATA_LENGTH = 200;
const CLIENT_KEY_CREATE_FIELDS = new Set(["name", "budgetUsd", "allowedModels", "expiresAt"]);
const CLIENT_KEY_PATCH_FIELDS = new Set(["name", "isActive", "budgetUsd", "allowedModels", "expiresAt"]);
const PROVIDER_KEY_CREATE_FIELDS = new Set(["provider", "apiKey", "name", "defaultModel", "providerSpecificData"]);

function json(body, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

function fail(status, error, extra = {}) {
  return json({ error, ...extra }, status);
}

async function readBody(request) {
  const body = await request.json().catch(() => undefined);
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  return body;
}

function unknownFields(body, allowed) {
  return Object.keys(body).filter((k) => !allowed.has(k));
}

function parseName(raw, { required }) {
  if (raw === undefined) return required ? { error: "name is required" } : {};
  if (typeof raw !== "string" || !raw.trim()) return { error: "name must be a non-empty string" };
  if (raw.trim().length > MAX_NAME_LENGTH) return { error: `name can be at most ${MAX_NAME_LENGTH} characters` };
  return { name: raw.trim() };
}

async function audit(mk, action, targetType, targetId, detail) {
  try {
    await addManagementAudit({ managementKeyId: mk.id, action, targetType, targetId, detail });
  } catch (e) {
    console.warn(`[management] audit write failed: ${e.message}`);
  }
}

/** Authenticate, then run fn with the management key. */
async function withKey(request, fn) {
  const auth = await authenticateManagementKey(request);
  if (!auth.ok) return fail(auth.status, auth.error);
  try { await touchManagementKey(auth.managementKey.id); } catch {}
  try {
    return await fn(auth.managementKey);
  } catch (e) {
    console.warn(`[management] ${request.method} failed: ${e.message}`);
    return fail(500, "The management request failed");
  }
}

function requireClientScope(mk) {
  return mk.scopes.clientKeys.enabled ? null : fail(403, "This management key can't manage client keys");
}

function requireProviderScope(mk) {
  return mk.scopes.providerKeys.enabled ? null : fail(403, "This management key can't manage provider keys");
}

// ---- GET /me -----------------------------------------------------------------

export function getMe(request) {
  return withKey(request, async (mk) => json({ managementKey: serializeManagementKey(mk) }));
}

// ---- Client keys -------------------------------------------------------------

/** The client key with this id, when this management key can see it. */
async function findVisibleClientKey(mk, id) {
  const key = typeof id === "string" && id ? await getApiKeyById(id) : null;
  if (!key) return null;
  const owner = await getRowOwner("clientKey", key.id);
  return (await clientKeyVisible(mk, key, owner)) ? { key, owner } : null;
}

export function listClientKeys(request) {
  return withKey(request, async (mk) => {
    const denied = requireClientScope(mk);
    if (denied) return denied;
    const [keys, owners] = await Promise.all([getApiKeys(), getRowOwners("clientKey")]);
    const visible = [];
    for (const key of keys) {
      const owner = owners.get(key.id) || null;
      if (await clientKeyVisible(mk, key, owner)) visible.push(serializeClientKey(key, owner, mk.id));
    }
    return json({ clientKeys: visible });
  });
}

export function createClientKey(request) {
  return withKey(request, async (mk) => {
    const denied = requireClientScope(mk);
    if (denied) return denied;
    const body = await readBody(request);
    if (!body) return fail(400, "Body must be a JSON object");
    const extra = unknownFields(body, CLIENT_KEY_CREATE_FIELDS);
    if (extra.length) return fail(400, `Unknown or not allowed fields: ${extra.join(", ")}`);
    const name = parseName(body.name, { required: true });
    if (name.error) return fail(400, name.error);
    const limits = parseKeyLimitsInput(body);
    if (limits.errors.length) return fail(400, limits.errors.join("; "), { errors: limits.errors });

    const wanted = { allowedModels: limits.data.allowedModels ?? null, budgetUsd: limits.data.budgetUsd ?? null };
    const violation = await clientKeyScopeViolation(mk.scopes.clientKeys, wanted);
    if (violation) {
      await audit(mk, "client_key.create.denied", "clientKey", null, { name: name.name, ...wanted, reason: violation });
      return fail(403, violation);
    }

    const machineId = await getConsistentMachineId();
    const created = await createApiKey(name.name, machineId);
    let saved;
    try {
      saved = Object.keys(limits.data).length ? await updateApiKey(created.id, limits.data) : await getApiKeyById(created.id);
      await setRowOwner("clientKey", created.id, mk.id);
    } catch (e) {
      // Don't leave a key without its limits or its owner behind.
      await deleteApiKey(created.id).catch(() => {});
      throw e;
    }
    await audit(mk, "client_key.create", "clientKey", created.id, {
      name: saved.name, budgetUsd: saved.budgetUsd, allowedModels: saved.allowedModels, expiresAt: saved.expiresAt,
    });
    // The only response that ever carries a full client key.
    return json({ clientKey: serializeClientKey(saved, mk.id, mk.id), key: created.key }, 201);
  });
}

export function getClientKey(request, id) {
  return withKey(request, async (mk) => {
    const denied = requireClientScope(mk);
    if (denied) return denied;
    const found = await findVisibleClientKey(mk, id);
    if (!found) return fail(404, "Client key not found");
    return json({ clientKey: serializeClientKey(found.key, found.owner, mk.id) });
  });
}

export function updateClientKey(request, id) {
  return withKey(request, async (mk) => {
    const denied = requireClientScope(mk);
    if (denied) return denied;
    const found = await findVisibleClientKey(mk, id);
    if (!found) return fail(404, "Client key not found");
    const body = await readBody(request);
    if (!body) return fail(400, "Body must be a JSON object");
    const extra = unknownFields(body, CLIENT_KEY_PATCH_FIELDS);
    if (extra.length) return fail(400, `Unknown or not allowed fields: ${extra.join(", ")}`);
    const name = parseName(body.name, { required: false });
    if (name.error) return fail(400, name.error);
    if (body.isActive !== undefined && typeof body.isActive !== "boolean") return fail(400, "isActive must be true or false");
    const limits = parseKeyLimitsInput(body);
    if (limits.errors.length) return fail(400, limits.errors.join("; "), { errors: limits.errors });

    const merged = { ...found.key, ...limits.data };
    const violation = await clientKeyScopeViolation(mk.scopes.clientKeys, merged);
    if (violation) {
      await audit(mk, "client_key.update.denied", "clientKey", found.key.id, {
        allowedModels: merged.allowedModels, budgetUsd: merged.budgetUsd, reason: violation,
      });
      return fail(403, violation);
    }
    const update = { ...limits.data };
    if (name.name) update.name = name.name;
    if (body.isActive !== undefined) update.isActive = body.isActive;
    const saved = await updateApiKey(found.key.id, update);
    if (!saved) return fail(404, "Client key not found");
    await audit(mk, "client_key.update", "clientKey", saved.id, { changed: Object.keys(update) });
    return json({ clientKey: serializeClientKey(saved, found.owner, mk.id) });
  });
}

export function removeClientKey(request, id) {
  return withKey(request, async (mk) => {
    const denied = requireClientScope(mk);
    if (denied) return denied;
    const found = await findVisibleClientKey(mk, id);
    if (!found) return fail(404, "Client key not found");
    if (!(await deleteApiKey(found.key.id))) return fail(404, "Client key not found");
    await audit(mk, "client_key.delete", "clientKey", found.key.id, { name: found.key.name });
    return json({ deleted: true, id: found.key.id });
  });
}

// ---- Provider keys -----------------------------------------------------------

async function findVisibleProviderKey(mk, id) {
  const conn = typeof id === "string" && id ? await getProviderConnectionById(id) : null;
  if (!conn) return null;
  const owner = await getRowOwner("providerKey", conn.id);
  return providerKeyVisible(mk, conn, owner) ? { conn, owner } : null;
}

export function listProviderKeys(request) {
  return withKey(request, async (mk) => {
    const denied = requireProviderScope(mk);
    if (denied) return denied;
    const provider = new URL(request.url).searchParams.get("provider");
    const [connections, owners] = await Promise.all([
      getProviderConnections(provider ? { provider: normalizeProviderId(provider) } : {}),
      getRowOwners("providerKey"),
    ]);
    const visible = connections
      .filter((c) => providerKeyVisible(mk, c, owners.get(c.id) || null))
      .map((c) => serializeProviderKey(c, owners.get(c.id) || null, mk.id));
    return json({ providerKeys: visible });
  });
}

function parseProviderData(raw) {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) return { error: "providerSpecificData must be an object" };
  const data = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!PROVIDER_DATA_FIELDS.has(k)) return { error: `providerSpecificData.${k} can't be set through the management API` };
    if (typeof v !== "string" || v.length > MAX_PROVIDER_DATA_LENGTH) return { error: `providerSpecificData.${k} must be a string of at most ${MAX_PROVIDER_DATA_LENGTH} characters` };
    data[k] = v;
  }
  return { data: Object.keys(data).length ? data : undefined };
}

// The dashboard's own add-key path: the validation ping, then the create route.
// Imported lazily so the provider and model tables load only when a key is added.
async function dashboardProviderRoutes() {
  const [validate, providers] = await Promise.all([
    import("@/app/api/providers/validate/route.js"),
    import("@/app/api/providers/route.js"),
  ]);
  return { validate: validate.POST, create: providers.POST };
}

// An internal request with no forwarding headers, so the dashboard routes treat
// it as remote (the strict URL rules) whatever the caller's address is.
function internalJsonRequest(path, body) {
  return new Request(`http://management.internal${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function createProviderKey(request) {
  return withKey(request, async (mk) => {
    const denied = requireProviderScope(mk);
    if (denied) return denied;
    const body = await readBody(request);
    if (!body) return fail(400, "Body must be a JSON object");
    const extra = unknownFields(body, PROVIDER_KEY_CREATE_FIELDS);
    if (extra.length) return fail(400, `Unknown or not allowed fields: ${extra.join(", ")}`);
    if (typeof body.provider !== "string" || !body.provider.trim()) return fail(400, "provider is required");
    const provider = normalizeProviderId(body.provider);
    if (!providerInScope(mk.scopes.providerKeys, provider)) {
      await audit(mk, "provider_key.create.denied", "providerKey", null, { provider, reason: "provider outside scope" });
      return fail(403, `This management key can't add keys for provider "${provider}"`);
    }
    if (typeof body.apiKey !== "string" || !body.apiKey.trim()) return fail(400, "apiKey is required");
    const name = parseName(body.name, { required: false });
    if (name.error) return fail(400, name.error);
    if (body.defaultModel !== undefined && (typeof body.defaultModel !== "string" || body.defaultModel.length > 300)) {
      return fail(400, "defaultModel must be a model id");
    }
    const psd = parseProviderData(body.providerSpecificData);
    if (psd.error) return fail(400, psd.error);

    const routes = await dashboardProviderRoutes();
    const apiKey = body.apiKey.trim();
    const check = await routes.validate(internalJsonRequest("/api/providers/validate", { provider, apiKey, providerSpecificData: psd.data }));
    const checked = await check.json().catch(() => ({}));
    if (!check.ok) return fail(check.status, typeof checked.error === "string" ? checked.error : "Could not validate the key");
    if (checked.valid !== true) {
      // The validator's own error text is not passed on: it can quote the upstream.
      await audit(mk, "provider_key.create.denied", "providerKey", null, { provider, reason: "the provider did not accept the key" });
      return fail(422, "The provider did not accept this key, so it was not added");
    }

    const connectionName = name.name || `${mk.name} ${crypto.randomBytes(3).toString("hex")}`;
    const res = await routes.create(internalJsonRequest("/api/providers", {
      provider,
      apiKey,
      name: connectionName,
      defaultModel: body.defaultModel,
      providerSpecificData: psd.data,
      testStatus: "active",
    }));
    const out = await res.json().catch(() => ({}));
    if (res.status === 409) return fail(409, `A key named "${connectionName}" already exists for this provider; pick another name`);
    if (!res.ok || !out.connection?.id) return fail(res.ok ? 500 : res.status, typeof out.error === "string" ? out.error : "Could not add the key");

    await setRowOwner("providerKey", out.connection.id, mk.id);
    const saved = await getProviderConnectionById(out.connection.id);
    await audit(mk, "provider_key.create", "providerKey", saved.id, { provider: saved.provider, name: saved.name });
    return json({ providerKey: serializeProviderKey(saved, mk.id, mk.id) }, 201);
  });
}

export function getProviderKey(request, id) {
  return withKey(request, async (mk) => {
    const denied = requireProviderScope(mk);
    if (denied) return denied;
    const found = await findVisibleProviderKey(mk, id);
    if (!found) return fail(404, "Provider key not found");
    return json({ providerKey: serializeProviderKey(found.conn, found.owner, mk.id) });
  });
}

export function removeProviderKey(request, id) {
  return withKey(request, async (mk) => {
    const denied = requireProviderScope(mk);
    if (denied) return denied;
    const found = await findVisibleProviderKey(mk, id);
    if (!found) return fail(404, "Provider key not found");
    if (!(await deleteProviderConnection(found.conn.id))) return fail(404, "Provider key not found");
    await audit(mk, "provider_key.delete", "providerKey", found.conn.id, { provider: found.conn.provider, name: found.conn.name });
    return json({ deleted: true, id: found.conn.id });
  });
}
