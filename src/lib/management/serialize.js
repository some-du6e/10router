// What the management API returns for each row. Built field by field from an
// allowlist, never by spreading the row, so a secret added to a row later
// can't leak through here. Provider secrets (apiKey, accessToken,
// refreshToken, idToken, providerSpecificData) and full client keys are never
// included; the one exception, a new client key's secret, is added by the
// create handler alone.
import { maskApiKey } from "@/lib/db/repos/usageRepo.js";

export function serializeClientKey(key, ownerId, managementKeyId) {
  return {
    id: key.id,
    name: key.name ?? null,
    keyPreview: maskApiKey(key.key),
    isActive: key.isActive !== false,
    budgetUsd: key.budgetUsd ?? null,
    allowedModels: key.allowedModels ?? null,
    expiresAt: key.expiresAt ?? null,
    spentUsd: key.spentUsd ?? 0,
    lifetimeSpentUsd: key.lifetimeSpentUsd ?? 0,
    requestCount: key.requestCount ?? 0,
    lastUsedAt: key.lastUsedAt ?? null,
    createdAt: key.createdAt ?? null,
    createdByYou: !!ownerId && ownerId === managementKeyId,
  };
}

export function serializeProviderKey(conn, ownerId, managementKeyId) {
  return {
    id: conn.id,
    provider: conn.provider,
    name: conn.name ?? null,
    authType: conn.authType ?? null,
    isActive: conn.isActive !== false,
    testStatus: conn.testStatus ?? null,
    priority: conn.priority ?? null,
    createdAt: conn.createdAt ?? null,
    updatedAt: conn.updatedAt ?? null,
    createdByYou: !!ownerId && ownerId === managementKeyId,
  };
}

/** A management key as its holder sees it (GET /me) and as the dashboard lists it. Never the hash. */
export function serializeManagementKey(mk) {
  return {
    id: mk.id,
    name: mk.name,
    keyPrefix: mk.keyPrefix,
    scopes: mk.scopes,
    isActive: mk.isActive,
    expiresAt: mk.expiresAt,
    createdAt: mk.createdAt,
    lastUsedAt: mk.lastUsedAt,
  };
}
