// Authentication for the management API (/api/management/v1). The dashboard
// guard runs it before the route, and every route runs it again to get the key
// it acts as. A session cookie is never enough here, and a management key is
// never enough anywhere else. See docs/MANAGEMENT_KEYS.md.
import { findManagementKeyBySecret } from "@/lib/db/repos/managementKeysRepo.js";
import { isManagementKeyToken } from "@/shared/utils/managementKey.js";
import { isKeyExpired } from "@/shared/utils/apiKeyLimits.js";

export const MANAGEMENT_API_PREFIX = "/api/management/v1";

/** Is this path on the management API? Segment-exact: "/api/management-keys" is not. */
export function isManagementApiPath(pathname) {
  return pathname === MANAGEMENT_API_PREFIX || (typeof pathname === "string" && pathname.startsWith(`${MANAGEMENT_API_PREFIX}/`));
}

/** The bearer token on the request, only when it is shaped like a management key. */
export function extractManagementKey(request) {
  const header = request?.headers?.get?.("authorization");
  if (!header || !header.startsWith("Bearer ")) return null;
  const token = header.slice(7).trim();
  return isManagementKeyToken(token) ? token : null;
}

/**
 * @returns {Promise<{ ok: true, managementKey: object } | { ok: false, status: number, error: string }>}
 */
export async function authenticateManagementKey(request) {
  const secret = extractManagementKey(request);
  if (!secret) {
    return { ok: false, status: 401, error: "A management key is required: send Authorization: Bearer 10r-mgmt-…" };
  }
  let managementKey = null;
  try {
    managementKey = await findManagementKeyBySecret(secret);
  } catch {
    return { ok: false, status: 503, error: "Could not check the management key" };
  }
  if (!managementKey) return { ok: false, status: 401, error: "Invalid management key" };
  if (!managementKey.isActive) return { ok: false, status: 401, error: "This management key is turned off" };
  if (isKeyExpired(managementKey)) return { ok: false, status: 401, error: "This management key has expired" };
  return { ok: true, managementKey };
}
