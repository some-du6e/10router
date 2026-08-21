import "open-sse/index.js";

import {
  getNotificationChannels,
  getProviderConnections,
  getQuotaNotificationState,
  setQuotaNotificationState,
} from "@/lib/db/index.js";
import { getUsageForProvider } from "open-sse/services/usage.js";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy";
import { refreshAndUpdateCredentials } from "@/app/api/usage/[connectionId]/route.js";
import { USAGE_APIKEY_PROVIDERS, USAGE_SUPPORTED_PROVIDERS } from "@/shared/constants/providers";
import { NOTIFICATION_CONFIG } from "@/lib/notifications/constants.js";
import { dispatchNotificationEvent } from "@/lib/notifications/index.js";
import { detectQuotaTransitions } from "@/lib/notifications/quotaTransitions.js";

const g = (global.__quotaNotifications ??= {
  interval: null,
  running: false,
  lastPolledAt: {},
});

function supportsUsage(connection) {
  if (connection.authType === "oauth") return USAGE_SUPPORTED_PROVIDERS.includes(connection.provider);
  const apiKeyAuth = connection.authType === "apikey" || connection.authType === "api_key";
  return apiKeyAuth && USAGE_APIKEY_PROVIDERS.includes(connection.provider);
}

function pollIntervalFor(connection) {
  return connection.provider === "claude"
    ? NOTIFICATION_CONFIG.claudePollIntervalMs
    : NOTIFICATION_CONFIG.tickIntervalMs;
}

function buildProxyOptions(config) {
  return {
    connectionProxyEnabled: config.connectionProxyEnabled === true,
    connectionProxyUrl: config.connectionProxyUrl || "",
    connectionNoProxy: config.connectionNoProxy || "",
    vercelRelayUrl: config.vercelRelayUrl || "",
    strictProxy: false,
  };
}

async function pollConnection(connection, deps, state) {
  const now = Date.now();
  const lastPoll = state.lastPolledAt[connection.id] || 0;
  if (now - lastPoll < pollIntervalFor(connection)) return;
  state.lastPolledAt[connection.id] = now;

  const proxyConfig = await deps.resolveConnectionProxyConfig(connection.providerSpecificData);
  const proxyOptions = buildProxyOptions(proxyConfig);
  let current = connection;
  if (connection.authType === "oauth") {
    current = (await deps.refreshAndUpdateCredentials(connection, false, proxyOptions)).connection;
  }

  const usage = await deps.getUsageForProvider(current, proxyOptions);
  if (!usage?.quotas || typeof usage.quotas !== "object") return;

  const previous = await deps.getQuotaNotificationState(current.id);
  const { events, state: nextState } = detectQuotaTransitions(previous, usage);
  await deps.setQuotaNotificationState(current.id, nextState);

  for (const event of events) {
    const result = await deps.dispatchNotificationEvent({
      ...event,
      timestamp: new Date().toISOString(),
      provider: current.provider,
      connectionId: current.id,
      connectionName: current.name || current.email || current.displayName || current.id,
    });
    for (const failure of result.failures || []) {
      console.warn(`[Notifications] ${failure.name}: ${failure.error}`);
    }
  }
}

function createDefaultDeps() {
  return {
    getNotificationChannels,
    getProviderConnections,
    getQuotaNotificationState,
    setQuotaNotificationState,
    getUsageForProvider,
    resolveConnectionProxyConfig,
    refreshAndUpdateCredentials,
    dispatchNotificationEvent,
  };
}

export async function runQuotaNotificationTick(deps = createDefaultDeps(), state = g) {
  if (state.running) return;
  state.running = true;
  try {
    const channels = await deps.getNotificationChannels({ isActive: true });
    if (channels.length === 0) return;

    const connections = (await deps.getProviderConnections({ isActive: true })).filter(supportsUsage);
    for (const connection of connections) {
      try {
        await pollConnection(connection, deps, state);
      } catch (error) {
        console.warn(`[Notifications] ${connection.provider}:${connection.id}: ${error.message}`);
      }
    }
  } catch (error) {
    console.warn("[Notifications] tick failed:", error.message);
  } finally {
    state.running = false;
  }
}

export function startQuotaNotifications() {
  if (g.interval) return;
  console.log("[Notifications] quota monitor started");
  runQuotaNotificationTick().catch(() => {});
  g.interval = setInterval(() => runQuotaNotificationTick().catch(() => {}), NOTIFICATION_CONFIG.tickIntervalMs);
  g.interval.unref?.();
}

export function stopQuotaNotifications() {
  if (!g.interval) return;
  clearInterval(g.interval);
  g.interval = null;
  console.log("[Notifications] quota monitor stopped");
}

export function configureQuotaNotifications(hasActiveChannels) {
  if (hasActiveChannels) startQuotaNotifications();
  else stopQuotaNotifications();
}
