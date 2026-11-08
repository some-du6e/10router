// The management API: what a management key can do with client keys and
// provider keys. Route files under src/app/api/management/v1 call these.
// Every handler authenticates the key itself (the dashboard guard has already
// checked it too), stays inside the key's scopes, and returns rows through
// serialize.js only. There is deliberately no handler for management keys
// themselves: those are created, edited and listed in the dashboard alone.
// See docs/MANAGEMENT_KEYS.md.
import crypto from "node:crypto";
import {
  getApiKeys, getApiKeyById, updateApiKey, deleteApiKey,
  getProviderConnections, getProviderConnectionById, deleteProviderConnection,
  touchManagementKey, setRowOwner, getRowOwners, getRowOwner, addManagementAudit,
  createOwnedApiKey, recordApiKeyActor,
} from "@/lib/db/index.js";
import { getConsistentMachineId } from "@/shared/utils/machineId";
import { parseKeyLimitsInput } from "@/shared/utils/apiKeyLimits.js";
import { normalizeManagementKeyName } from "@/shared/utils/managementKey.js";
import { normalizeProviderId } from "@/lib/providerNormalization";
import { WEB_COOKIE_PROVIDERS } from "@/shared/constants/providers";
import { authenticateManagementKey } from "./auth.js";
import {
  clientKeyScopeViolation, clientKeyVisible, dashboardChoiceViolation,
  providerInScope, providerKeyVisible, makeProviderResolver,
} from "./policy.js";
import { serializeClientKey, serializeProviderKey, serializeManagementKey } from "./serialize.js";
import { json, fail, readBody } from "./http.js";

// Provider-specific fields a management key may set. URL fields (baseUrl,
// azureEndpoint, proxies) are left out: they decide where the gateway sends a
// key, which is the dashboard's call.
const PROVIDER_DATA_FIELDS = new Set(["accountId", "region", "deployment", "organization", "apiVersion"]);
const MAX_PROVIDER_DATA_LENGTH = 200;
export const MAX_PROVIDER_API_KEY_LENGTH = 8192;
const CLIENT_KEY_CREATE_FIELDS = new Set(["name", "budgetUsd", "allowedModels", "expiresAt"]);
const CLIENT_KEY_PATCH_FIELDS = new Set(["name", "isActive", "budgetUsd", "allowedModels", "expiresAt"]);
const PROVIDER_KEY_CREATE_FIELDS = new Set(["provider", "apiKey", "name", "defaultModel", "providerSpecificData"]);
const DEFAULT_PROBE_TIMEOUT_MS = 15_000;

function probeTimeoutMs() {
  return Number(process.env.MANAGEMENT_PROBE_TIMEOUT_MS) || DEFAULT_PROBE_TIMEOUT_MS;
}

function parseName(raw, { required }) {
  if (raw === undefined) return required ? { error: "name is required" } : {};
  return normalizeManagementKeyName(raw);
}

async function audit(mk, action, targetType, targetId, detail, { denied = false } = {}) {
  try {
    await addManagementAudit({ managementKeyId: mk.id, action, targetType, targetId, detail, denied });
  } catch (e) {
    console.warn(`[management] audit write failed: ${e.message}`);
  }
}

const SCOPE_REFUSALS = {
  clientKeys: "This management key can't manage client keys",
  providerKeys: "This management key can't manage provider keys",
};

/** Authenticate, check the key has this kind of scope (if any), then run fn with it. */
async function withKey(request, scope, fn) {
  const auth = await authenticateManagementKey(request);
  if (!auth.ok) return fail(auth.status, auth.error);
  try { await touchManagementKey(auth.managementKey.id); } catch {}
  if (scope && !auth.managementKey.scopes[scope].enabled) return fail(403, SCOPE_REFUSALS[scope]);
  try {
    return await fn(auth.managementKey);
  } catch (e) {
    console.warn(`[management] ${request.method} failed: ${e.message}`);
    return fail(500, "The management request failed");
  }
}

// ---- GET /me -----------------------------------------------------------------

export function getMe(request) {
  return withKey(request, null, async (mk) => json({ managementKey: serializeManagementKey(mk) }));
}

// ---- Client keys -------------------------------------------------------------

/** The client key with this id, when this management key can see it. */
async function findVisibleClientKey(mk, id) {
  const key = typeof id === "string" && id ? await getApiKeyById(id) : null;
  if (!key) return null;
  return (await clientKeyVisible(mk, key, key.ownerManagementKeyId)) ? key : null;
}

export function listClientKeys(request) {
  return withKey(request, "clientKeys", async (mk) => {
    const keys = await getApiKeys();
    const resolveProvider = makeProviderResolver();
    const visible = [];
    for (const key of keys) {
      if (await clientKeyVisible(mk, key, key.ownerManagementKeyId, resolveProvider)) {
        visible.push(serializeClientKey(key, key.ownerManagementKeyId, mk.id));
      }
    }
    return json({ clientKeys: visible });
  });
}

export function createClientKey(request) {
  return withKey(request, "clientKeys", async (mk) => {
    const { body, error } = await readBody(request, CLIENT_KEY_CREATE_FIELDS);
    if (error) return error;
    const name = parseName(body.name, { required: true });
    if (name.error) return fail(400, name.error);
    const limits = parseKeyLimitsInput(body);
    if (limits.errors.length) return fail(400, limits.errors.join("; "), { errors: limits.errors });

    const wanted = { allowedModels: limits.data.allowedModels ?? null, budgetUsd: limits.data.budgetUsd ?? null };
    const violation = await clientKeyScopeViolation(mk.scopes.clientKeys, wanted);
    if (violation) {
      await audit(mk, "client_key.create.denied", "clientKey", null, { name: name.name, ...wanted, reason: violation }, { denied: true });
      return fail(403, violation);
    }

    // One insert with its limits and owner: never a moment as an unrestricted key.
    const created = await createOwnedApiKey({ name: name.name, machineId: await getConsistentMachineId(), limits: limits.data, ownerId: mk.id });
    await audit(mk, "client_key.create", "clientKey", created.id, {
      name: created.name, budgetUsd: created.budgetUsd, allowedModels: created.allowedModels, expiresAt: created.expiresAt,
    });
    // The only response that ever carries a full client key.
    return json({ clientKey: serializeClientKey(created, mk.id, mk.id), key: created.key }, 201);
  });
}

export function getClientKey(request, id) {
  return withKey(request, "clientKeys", async (mk) => {
    const key = await findVisibleClientKey(mk, id);
    if (!key) return fail(404, "Client key not found");
    return json({ clientKey: serializeClientKey(key, key.ownerManagementKeyId, mk.id) });
  });
}

export function updateClientKey(request, id) {
  return withKey(request, "clientKeys", async (mk) => {
    const key = await findVisibleClientKey(mk, id);
    if (!key) return fail(404, "Client key not found");
    const { body, error } = await readBody(request, CLIENT_KEY_PATCH_FIELDS);
    if (error) return error;
    const name = parseName(body.name, { required: false });
    if (name.error) return fail(400, name.error);
    if (body.isActive !== undefined && typeof body.isActive !== "boolean") return fail(400, "isActive must be true or false");
    const limits = parseKeyLimitsInput(body);
    if (limits.errors.length) return fail(400, limits.errors.join("; "), { errors: limits.errors });

    const update = { ...limits.data };
    if (name.name) update.name = name.name;
    if (body.isActive !== undefined) update.isActive = body.isActive;
    const violation = (await clientKeyScopeViolation(mk.scopes.clientKeys, { ...key, ...limits.data }))
      || dashboardChoiceViolation(key, update);
    if (violation) {
      await audit(mk, "client_key.update.denied", "clientKey", key.id, { changed: Object.keys(update), reason: violation }, { denied: true });
      return fail(403, violation);
    }
    await updateApiKey(key.id, update);
    await recordApiKeyActor(key.id, { isActive: update.isActive, expiresAt: update.expiresAt }, mk.id);
    const saved = await getApiKeyById(key.id);
    if (!saved) return fail(404, "Client key not found");
    await audit(mk, "client_key.update", "clientKey", saved.id, { changed: Object.keys(update) });
    return json({ clientKey: serializeClientKey(saved, saved.ownerManagementKeyId, mk.id) });
  });
}

export function removeClientKey(request, id) {
  return withKey(request, "clientKeys", async (mk) => {
    const key = await findVisibleClientKey(mk, id);
    if (!key) return fail(404, "Client key not found");
    if (!(await deleteApiKey(key.id))) return fail(404, "Client key not found");
    await audit(mk, "client_key.delete", "clientKey", key.id, { name: key.name });
    return json({ deleted: true, id: key.id });
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
  return withKey(request, "providerKeys", async (mk) => {
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
function internalJsonRequest(path, body, signal) {
  return new Request(`http://management.internal${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
}

const PROBE_TIMED_OUT = Symbol("probe timed out");

/** The validation ping, given up on after the probe timeout. */
async function probeKey(validate, payload) {
  const ms = probeTimeoutMs();
  const signal = AbortSignal.timeout(ms);
  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(PROBE_TIMED_OUT), ms); });
  try {
    const res = await Promise.race([validate(internalJsonRequest("/api/providers/validate", payload, signal)), timeout]);
    if (res === PROBE_TIMED_OUT) return res;
    return { res, body: await res.json().catch(() => ({})) };
  } finally {
    clearTimeout(timer);
  }
}

export function createProviderKey(request) {
  return withKey(request, "providerKeys", async (mk) => {
    const { body, error } = await readBody(request, PROVIDER_KEY_CREATE_FIELDS);
    if (error) return error;
    if (typeof body.provider !== "string" || !body.provider.trim()) return fail(400, "provider is required");
    const provider = normalizeProviderId(body.provider);
    if (!providerInScope(mk.scopes.providerKeys, provider)) {
      await audit(mk, "provider_key.create.denied", "providerKey", null, { provider, reason: "provider outside scope" }, { denied: true });
      return fail(403, `This management key can't add keys for provider "${provider}"`);
    }
    // A session cookie is a login, not an API key; those stay a dashboard job.
    if (WEB_COOKIE_PROVIDERS[provider]) return fail(400, `"${provider}" takes a session cookie, which can only be added in the dashboard`);
    if (typeof body.apiKey !== "string" || !body.apiKey.trim()) return fail(400, "apiKey is required");
    if (body.apiKey.length > MAX_PROVIDER_API_KEY_LENGTH) return fail(400, `apiKey can be at most ${MAX_PROVIDER_API_KEY_LENGTH} characters`);
    const name = parseName(body.name, { required: false });
    if (name.error) return fail(400, name.error);
    if (body.defaultModel !== undefined && (typeof body.defaultModel !== "string" || body.defaultModel.length > 300)) {
      return fail(400, "defaultModel must be a model id");
    }
    const psd = parseProviderData(body.providerSpecificData);
    if (psd.error) return fail(400, psd.error);

    const routes = await dashboardProviderRoutes();
    const apiKey = body.apiKey.trim();
    const probe = await probeKey(routes.validate, { provider, apiKey, providerSpecificData: psd.data });
    if (probe === PROBE_TIMED_OUT) return fail(504, `The provider did not answer the validation request within ${Math.round(probeTimeoutMs() / 1000)}s; the key was not added`);
    if (!probe.res.ok) return fail(probe.res.status, typeof probe.body.error === "string" ? probe.body.error : "Could not validate the key");
    if (probe.body.valid !== true) {
      // The validator's own error text is not passed on: it can quote the upstream.
      await audit(mk, "provider_key.create.denied", "providerKey", null, { provider, reason: "the provider did not accept the key" }, { denied: true });
      return fail(422, "The provider did not accept this key, so it was not added");
    }

    // The probe can take seconds; the key may have been revoked or narrowed meanwhile.
    const again = await authenticateManagementKey(request);
    if (!again.ok) return fail(again.status, again.error);
    if (!providerInScope(again.managementKey.scopes.providerKeys, provider)) {
      await audit(mk, "provider_key.create.denied", "providerKey", null, { provider, reason: "scope narrowed during validation" }, { denied: true });
      return fail(403, `This management key can't add keys for provider "${provider}"`);
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

    let saved;
    try {
      await setRowOwner("providerKey", out.connection.id, mk.id);
      saved = await getProviderConnectionById(out.connection.id);
    } catch (e) {
      // Without its owner the key would read as the dashboard's; don't keep it.
      await deleteProviderConnection(out.connection.id).catch(() => {});
      throw e;
    }
    await audit(mk, "provider_key.create", "providerKey", saved.id, { provider: saved.provider, name: saved.name });
    return json({ providerKey: serializeProviderKey(saved, mk.id, mk.id) }, 201);
  });
}

export function getProviderKey(request, id) {
  return withKey(request, "providerKeys", async (mk) => {
    const found = await findVisibleProviderKey(mk, id);
    if (!found) return fail(404, "Provider key not found");
    return json({ providerKey: serializeProviderKey(found.conn, found.owner, mk.id) });
  });
}

export function removeProviderKey(request, id) {
  return withKey(request, "providerKeys", async (mk) => {
    const found = await findVisibleProviderKey(mk, id);
    if (!found) return fail(404, "Provider key not found");
    if (!(await deleteProviderConnection(found.conn.id))) return fail(404, "Provider key not found");
    await audit(mk, "provider_key.delete", "providerKey", found.conn.id, { provider: found.conn.provider, name: found.conn.name });
    return json({ deleted: true, id: found.conn.id });
  });
}
