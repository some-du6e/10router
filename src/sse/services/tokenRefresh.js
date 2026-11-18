// Re-export from open-sse with local logger
import * as log from "../utils/logger.js";
import { getProviderConnectionById, updateProviderConnection } from "../../lib/localDb.js";
import {
  getProjectIdForConnection,
  invalidateProjectId,
  removeConnection,
} from "open-sse/services/projectId.js";
import {
  TOKEN_EXPIRY_BUFFER_MS as BUFFER_MS,
  refreshAccessToken as _refreshAccessToken,
  refreshClaudeOAuthToken as _refreshClaudeOAuthToken,
  refreshGoogleToken as _refreshGoogleToken,
  refreshCodexToken as _refreshCodexToken,
  refreshIflowToken as _refreshIflowToken,
  refreshGitHubToken as _refreshGitHubToken,
  refreshCopilotToken as _refreshCopilotToken,
  getAccessToken as _getAccessToken,
  refreshTokenByProvider as _refreshTokenByProvider,
  formatProviderCredentials as _formatProviderCredentials,
  getAllAccessTokens as _getAllAccessTokens,
  refreshKiroToken as _refreshKiroToken,
  getRefreshLeadMs as _getRefreshLeadMs
} from "open-sse/services/tokenRefresh.js";
import {
  refreshProviderCredentials as _refreshProviderCredentials,
  shouldRefreshCredentials as _shouldRefreshCredentials,
} from "open-sse/services/oauthCredentialManager.js";
import { expiresAtFromNow } from "open-sse/utils/tokenExpiry.js";

export const TOKEN_EXPIRY_BUFFER_MS = BUFFER_MS;

// ─── Re-exports wrapped with local logger ─────────────────────────────────────

export const refreshAccessToken = (provider, refreshToken, credentials) =>
  _refreshAccessToken(provider, refreshToken, credentials, log);

export const refreshClaudeOAuthToken = (refreshToken) =>
  _refreshClaudeOAuthToken(refreshToken, log);

export const refreshGoogleToken = (refreshToken, clientId, clientSecret) =>
  _refreshGoogleToken(refreshToken, clientId, clientSecret, log);

export const refreshCodexToken = (refreshToken) =>
  _refreshCodexToken(refreshToken, log);

export const refreshIflowToken = (refreshToken) =>
  _refreshIflowToken(refreshToken, log);

export const refreshGitHubToken = (refreshToken) =>
  _refreshGitHubToken(refreshToken, log);

export const refreshCopilotToken = (githubAccessToken) =>
  _refreshCopilotToken(githubAccessToken, log);

export const refreshKiroToken = (refreshToken, providerSpecificData) =>
  _refreshKiroToken(refreshToken, providerSpecificData, log);

export const getAccessToken = (provider, credentials) =>
  _getAccessToken(provider, credentials, log);

export const refreshTokenByProvider = (provider, credentials) =>
  _refreshTokenByProvider(provider, credentials, log);

export const formatProviderCredentials = (provider, credentials) =>
  _formatProviderCredentials(provider, credentials, log);

export const getAllAccessTokens = (userInfo) =>
  _getAllAccessTokens(userInfo, log);

export const shouldRefreshCredentials = (provider, credentials) =>
  _shouldRefreshCredentials(provider, credentials);

// ─── Lifecycle hook ───────────────────────────────────────────────────────────

/**
 * Call this when a connection is fully closed / removed.
 * Aborts any in-flight projectId fetch and evicts its cache entry,
 * preventing the module-level Maps from accumulating stale entries.
 *
 * @param {string} connectionId
 */
export function releaseConnection(connectionId) {
  if (!connectionId) return;
  removeConnection(connectionId);
  log.debug("TOKEN_REFRESH", "Released connection resources", { connectionId });
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function normalizeExpiresAt(expiresAt) {
  if (!expiresAt) return null;
  const date = new Date(expiresAt);
  if (!Number.isFinite(date.getTime())) return null;
  return date.toISOString();
}

/**
 * Providers that carry a real Google project ID.
 * @param {string} provider
 * @returns {boolean}
 */
function needsProjectId(provider) {
  return provider === "antigravity" || provider === "gemini-cli";
}

/**
 * Non-blocking: fetch the project ID for a connection after a token refresh and
 * persist it to localDb.  Invalidates the stale cached value first so the fetch
 * always retrieves a fresh one.
 *
 * @param {string} provider
 * @param {string} connectionId
 * @param {string} accessToken
 */
function _refreshProjectId(provider, connectionId, accessToken) {
  if (!needsProjectId(provider) || !connectionId || !accessToken) return;

  // Evict the stale cached entry so getProjectIdForConnection does a real fetch
  invalidateProjectId(connectionId);

  getProjectIdForConnection(connectionId, accessToken)
    .then((projectId) => {
      if (!projectId) return;
      updateProviderCredentials(connectionId, { projectId }).catch((err) => {
        log.debug("TOKEN_REFRESH", "Failed to persist refreshed projectId", {
          connectionId,
          error: err?.message ?? err,
        });
      });
    })
    .catch((err) => {
      log.debug("TOKEN_REFRESH", "Failed to fetch projectId after token refresh", {
        connectionId,
        error: err?.message ?? err,
      });
    });
}

// ─── Local-specific: persist credentials to localDb ──────────────────────────

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

// ─── Local-specific: proactive token refresh ─────────────────────────────────

/**
 * Check whether the provider token (and, for GitHub, the Copilot token) is
 * about to expire and refresh it proactively.
 *
 * @param {string} provider
 * @param {object} credentials
 * @param {{ force?: boolean }} [options]  force=true skips the on-request lead check
 *   (used by background scheduler which applies a larger lead). Request path omits this.
 * @returns {Promise<object>} updated credentials object
 */
export async function checkAndRefreshToken(provider, credentials, options = {}) {
  let creds = { ...credentials };
  if (!creds.connectionId && creds.id) {
    creds.connectionId = creds.id;
  }

  // Adopt latest DB tokens: OpenAI rotates the refresh token on every refresh, and
  // refreshing with a stale snapshot (reuse) revokes the whole session → account logout.
  if (creds.connectionId) {
    const latest = await getProviderConnectionById(creds.connectionId).catch(() => null);
    const latestRefreshMs = Date.parse(latest?.lastRefreshAt || "");
    const credsRefreshMs = Date.parse(creds.lastRefreshAt || "");
    const dbIsNewer = Number.isFinite(latestRefreshMs)
      && (!Number.isFinite(credsRefreshMs) || latestRefreshMs > credsRefreshMs);
    if (dbIsNewer && latest.refreshToken && latest.refreshToken !== creds.refreshToken) {
      creds = {
        ...creds,
        refreshToken: latest.refreshToken,
        accessToken: latest.accessToken || creds.accessToken,
        expiresAt: latest.accessToken
          ? (latest.expiresAt || latest.tokenExpiresAt || null)
          : creds.expiresAt,
        lastRefreshAt: latest.lastRefreshAt || creds.lastRefreshAt,
      };
    }
  }

  const force = options?.force === true;

  // ── 1. Regular access-token expiry ────────────────────────────────────────
  if (force || _shouldRefreshCredentials(provider, creds)) {
    const expiresAt = creds.expiresAt ? new Date(creds.expiresAt).getTime() : null;
    const remaining = expiresAt ? expiresAt - Date.now() : null;
    const refreshLead = _getRefreshLeadMs(provider);

    log.info("TOKEN_REFRESH", "Refreshing provider credentials proactively", {
      provider,
      expiresIn: remaining === null ? null : Math.round(remaining / 1000),
      refreshLeadMs: refreshLead,
      lastRefreshAt: creds.lastRefreshAt || null,
    });

    const newCreds = await _refreshProviderCredentials(provider, creds, log);
    if (newCreds?.accessToken || newCreds?.apiKey || newCreds?.copilotToken) {
      // The request goes on with the new tokens even if the save fails.
      await saveRefreshedCredentials(creds.connectionId, newCreds);

      creds = {
        ...creds,
        ...newCreds,
        expiresAt: expiresAtFromNow(newCreds.expiresIn)
          || normalizeExpiresAt(newCreds.expiresAt) || newCreds.expiresAt || creds.expiresAt,
        providerSpecificData: newCreds.providerSpecificData
          ? { ...creds.providerSpecificData, ...newCreds.providerSpecificData }
          : creds.providerSpecificData,
      };

      // Non-blocking: refresh projectId with the new access token
      _refreshProjectId(provider, creds.connectionId, creds.accessToken);
    }
  }

  // ── 2. GitHub Copilot token expiry ────────────────────────────────────────
  if (provider === "github") {
    const copilotToken = creds.providerSpecificData?.copilotToken;
    const copilotExpiresAt = creds.providerSpecificData?.copilotTokenExpiresAt
      ? creds.providerSpecificData.copilotTokenExpiresAt * 1000
      : 0;
    const now              = Date.now();
    const remaining        = copilotExpiresAt - now;

    if (!copilotToken || remaining < TOKEN_EXPIRY_BUFFER_MS) {
      log.info("TOKEN_REFRESH", "Copilot token expiring soon or missing, refreshing proactively", {
        provider,
        expiresIn: copilotToken ? Math.round(remaining / 1000) : "missing",
      });

      const copilotTokenResult = await refreshCopilotToken(creds.accessToken);
      if (copilotTokenResult?.token) {
        const copilotPatch = buildCredentialUpdates({
          copilotToken:          copilotTokenResult.token,
          copilotTokenExpiresAt: copilotTokenResult.expiresAt,
        }).providerSpecificData;

        await saveRefreshedCredentials(creds.connectionId, { providerSpecificData: copilotPatch });

        creds.providerSpecificData = { ...creds.providerSpecificData, ...copilotPatch };
        creds.copilotToken = copilotTokenResult.token;
      }
    }
  }

  return creds;
}

// ─── Local-specific: combined GitHub + Copilot refresh ───────────────────────

/**
 * Refresh the GitHub OAuth token and immediately exchange it for a fresh
 * Copilot token.
 *
 * @param {object} credentials  – must contain `refreshToken`
 * @returns {Promise<object|null>} merged credentials or the raw GitHub credentials on Copilot failure
 */
export async function refreshGitHubAndCopilotTokens(credentials) {
  const newGitHubCreds = await refreshGitHubToken(credentials.refreshToken);
  if (!newGitHubCreds?.accessToken) return newGitHubCreds;

  const copilotToken = await refreshCopilotToken(newGitHubCreds.accessToken);
  if (!copilotToken) return newGitHubCreds;

  return {
    ...newGitHubCreds,
    providerSpecificData: {
      copilotToken:          copilotToken.token,
      copilotTokenExpiresAt: copilotToken.expiresAt,
    },
  };
}
