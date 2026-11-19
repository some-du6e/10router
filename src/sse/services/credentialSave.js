// Saving a token refresh result to localDb. Kept apart from tokenRefresh.js,
// which pulls in the whole refresh engine, so the connection test and other
// callers that only save can import this alone.
import * as log from "../utils/logger.js";
import { updateProviderConnection } from "../../lib/localDb.js";
import { expiresAtFromNow, normalizeExpiresAt } from "open-sse/utils/tokenExpiry.js";

/**
 * The connection fields a refresh result changes. `providerSpecificData` in
 * the result is a patch (top-level Copilot fields join it); nothing else is read.
 *
 * @param {object} newCredentials
 * @returns {object}
 */
export function buildCredentialUpdates(newCredentials) {
  const updates = {};

  if (newCredentials.accessToken)         updates.accessToken  = newCredentials.accessToken;
  if (newCredentials.refreshToken)        updates.refreshToken = newCredentials.refreshToken;
  if (newCredentials.idToken)             updates.idToken = newCredentials.idToken;
  if (newCredentials.lastRefreshAt)       updates.lastRefreshAt = newCredentials.lastRefreshAt;
  const expiresInAt = expiresAtFromNow(newCredentials.expiresIn);
  if (expiresInAt) {
    updates.expiresAt = expiresInAt;
    updates.expiresIn = Number(newCredentials.expiresIn);
  } else if (newCredentials.expiresAt) {
    const expiresAt = normalizeExpiresAt(newCredentials.expiresAt);
    updates.expiresAt = expiresAt || newCredentials.expiresAt;
    if (expiresAt) {
      updates.expiresIn = Math.max(1, Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000));
    }
  }
  const providerSpecificData = {
    ...(newCredentials.providerSpecificData || {}),
    ...(newCredentials.copilotToken ? { copilotToken: newCredentials.copilotToken } : {}),
    ...(newCredentials.copilotTokenExpiresAt ? { copilotTokenExpiresAt: newCredentials.copilotTokenExpiresAt } : {}),
  };
  if (Object.keys(providerSpecificData).length > 0) updates.providerSpecificData = providerSpecificData;
  if (newCredentials.projectId)            updates.projectId = newCredentials.projectId;
  return updates;
}

/**
 * Persist a refresh result for a connection to localDb: only the fields it
 * carries, its providerSpecificData applied over the stored row, and
 * lastRefreshAt stamped when the access token changed.
 *
 * `options` go to updateProviderConnection (for example refreshTokenUsed);
 * the patch and stamp options are on unless set otherwise. Errors propagate.
 *
 * @param {string} connectionId
 * @param {object} newCredentials
 * @param {object} [options]
 * @returns {Promise<object|null>} the saved row, or null when nothing was written
 */
export async function updateProviderCredentials(connectionId, newCredentials, options = {}) {
  const updates = buildCredentialUpdates(newCredentials);
  const result = await updateProviderConnection(connectionId, updates, {
    patchProviderSpecificData: true,
    stampLastRefreshAt: true,
    ...options,
  });
  log.info("TOKEN_REFRESH", "Credentials updated in localDb", {
    connectionId,
    success: !!result
  });
  return result ?? null;
}

/**
 * updateProviderCredentials for callers that go on with the new tokens either
 * way: a failed save is logged and returns null instead of throwing.
 */
export async function saveRefreshedCredentials(connectionId, newCredentials) {
  try {
    return await updateProviderCredentials(connectionId, newCredentials);
  } catch (error) {
    log.error("TOKEN_REFRESH", "Error updating credentials in localDb", {
      connectionId,
      error: error.message,
    });
    return null;
  }
}
