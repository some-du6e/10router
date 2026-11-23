// Ensure proxyFetch is loaded to patch globalThis.fetch
import "open-sse/index.js";

import { getProviderConnectionById } from "@/lib/localDb";
import { buildCredentialUpdates, saveRefreshedCredentials } from "@/sse/services/tokenRefresh.js";
import { getUsageForProvider } from "open-sse/services/usage.js";
import { isUnrecoverableRefreshError } from "open-sse/services/tokenRefresh.js";
import { getExecutor } from "open-sse/executors/index.js";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy";
import { toProxyOptions } from "@/lib/network/proxyRouting";
import { USAGE_APIKEY_PROVIDERS } from "@/shared/constants/providers";

// Detect auth-expired messages returned by usage providers instead of throwing
const AUTH_EXPIRED_PATTERNS = ["expired", "authentication", "unauthorized", "401", "re-authorize"];
class CredentialReadError extends Error {}
function isAuthExpiredMessage(usage) {
  if (!usage?.message) return false;
  const msg = usage.message.toLowerCase();
  return AUTH_EXPIRED_PATTERNS.some((p) => msg.includes(p));
}

/**
 * Refresh credentials using executor and update database
 * @param {boolean} force - Skip needsRefresh check and always attempt refresh
 * @returns Promise<{ connection, refreshed: boolean }>
 */
export async function refreshAndUpdateCredentials(connection, force = false, proxyOptions = null) {
  // Re-read latest tokens: OpenAI rotates the refresh token on every refresh, and
  // refreshing with a stale snapshot (reuse) revokes the whole session → account logout.
  let latest;
  try {
    latest = connection.id ? await getProviderConnectionById(connection.id) : null;
  } catch (error) {
    throw new CredentialReadError("Unable to read current credentials. Please retry.", { cause: error });
  }
  if (latest) connection = latest;

  const executor = getExecutor(connection.provider);

  // Build credentials object from connection
  const credentials = {
    accessToken: connection.accessToken,
    refreshToken: connection.refreshToken,
    idToken: connection.idToken,
    expiresAt: connection.expiresAt || connection.tokenExpiresAt,
    lastRefreshAt: connection.lastRefreshAt,
    connectionId: connection.id,
    providerSpecificData: connection.providerSpecificData,
    // For GitHub
    copilotToken: connection.providerSpecificData?.copilotToken,
    copilotTokenExpiresAt: connection.providerSpecificData?.copilotTokenExpiresAt,
  };

  // Check if refresh is needed (skip when force=true)
  const needsRefresh = force || executor.needsRefresh(credentials);

  if (!needsRefresh) {
    return { connection, refreshed: false };
  }

  // Use executor's refreshCredentials method (with optional proxy)
  const refreshResult = await executor.refreshCredentials(credentials, console, proxyOptions);

  // Refresh token reused/invalidated — token family is revoked; do not continue with the dead token.
  if (refreshResult && isUnrecoverableRefreshError(refreshResult)) {
    throw new Error("Refresh token invalid or reused. Please re-authorize the connection.");
  }

  if (!refreshResult) {
    // Refresh failed but we still have an accessToken — try with existing token
    if (connection.accessToken) {
      return { connection, refreshed: false };
    }
    throw new Error("Failed to refresh credentials. Please re-authorize the connection.");
  }

  await saveRefreshedCredentials(connection.id, refreshResult);

  // The patch applied to this request's copy, the way the DB applied it.
  const updates = buildCredentialUpdates(refreshResult);
  const updatedConnection = {
    ...connection,
    ...updates,
    providerSpecificData: updates.providerSpecificData
      ? { ...(connection.providerSpecificData || {}), ...updates.providerSpecificData }
      : connection.providerSpecificData,
  };

  return {
    connection: updatedConnection,
    refreshed: true,
  };
}

/**
 * GET /api/usage/[connectionId] - Get usage data for a specific connection
 */
export async function GET(request, { params }) {
  let connection;
  try {
    const { connectionId } = await params;
    const force = new URL(request.url).searchParams.get("force") === "1";


    // Get connection from database
    connection = await getProviderConnectionById(connectionId);
    if (!connection) {
      return Response.json({ error: "Connection not found" }, { status: 404 });
    }

    // Allow OAuth connections, plus whitelisted apikey providers (glm/minimax/kiro/...)
    // Kiro's headless api-key flow persists authType "api_key" (underscore) while
    // generic apikey providers persist "apikey" — accept both spellings here.
    const isOAuth = connection.authType === "oauth";
    const isApikeyAuth =
      connection.authType === "apikey" || connection.authType === "api_key";
    const isApikeyEligible =
      isApikeyAuth && USAGE_APIKEY_PROVIDERS.includes(connection.provider);

    if (!isOAuth && !isApikeyEligible) {
      return Response.json({ message: "Usage not available for this connection" });
    }

    const proxyConfig = await resolveConnectionProxyConfig(connection.providerSpecificData, connection.provider);
    const proxyOptions = toProxyOptions(proxyConfig);

    // Refresh credentials only for OAuth connections (apikey has no token refresh)
    if (isOAuth) {
      try {
        const result = await refreshAndUpdateCredentials(connection, false, proxyOptions);
        connection = result.connection;
      } catch (refreshError) {
        if (refreshError instanceof CredentialReadError) throw refreshError;
        console.error("[Usage API] Credential refresh failed:", refreshError);
        return Response.json({
          error: `Credential refresh failed: ${refreshError.message}`
        }, { status: 401 });
      }
    }

    // Fetch usage from provider API
    let usage = await getUsageForProvider(connection, proxyOptions, { force });

    // If provider returned an auth-expired message instead of throwing,
    // force-refresh token and retry once (OAuth only)
    if (isOAuth && isAuthExpiredMessage(usage) && connection.refreshToken) {
      try {
        const retryResult = await refreshAndUpdateCredentials(connection, true, proxyOptions);
        connection = retryResult.connection;
        usage = await getUsageForProvider(connection, proxyOptions, { force });
      } catch (retryError) {
        if (retryError instanceof CredentialReadError) throw retryError;
        console.warn(`[Usage] ${connection.provider}: force refresh failed: ${retryError.message}`);
      }
    }

    return Response.json(usage);
  } catch (error) {
    const provider = connection?.provider ?? "unknown";
    console.warn(`[Usage] ${provider}: ${error.message}`);
    return Response.json({ error: error.message }, { status: 500 });
  }
}
