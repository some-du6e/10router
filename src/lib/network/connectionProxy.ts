import { getProxyPoolById, getSettings } from "@/lib/db/index.js";
import { chainPoolIds, resolveProxyChain, type AccountProxyFields, type ProxyPoolLike, type ResolvedProxy } from "./proxyRouting.js";

// ─── Proxy pool rotation state (in-memory) ─────────────────────────
const rotateState = new Map<string, { index: number }>(); // providerId → { index }

/**
 * Pick one proxy pool ID from a list based on strategy.
 * round-robin: cycle sequentially (in-memory, resets on restart)
 * random:      uniform random pick
 * none/single: return first entry
 */
export function pickProxyPoolId(poolIds: string[] | null | undefined, strategy: string, providerId: string): string | null {
  if (!poolIds || poolIds.length === 0) return null;
  if (poolIds.length === 1) return poolIds[0];

  if (strategy === "round-robin") {
    const state = rotateState.get(providerId) || { index: -1 };
    state.index = (state.index + 1) % poolIds.length;
    rotateState.set(providerId, state);
    return poolIds[state.index];
  }

  if (strategy === "random") {
    return poolIds[Math.floor(Math.random() * poolIds.length)];
  }

  return poolIds[0]; // "none" or unknown
}

/**
 * The proxy an account's requests use: its own setting, else its provider's
 * (settings.providerStrategies[provider].proxyPoolId), else Global
 * (settings.globalProxyPoolId), else the system outbound proxy. Without
 * `provider` the provider layer is skipped.
 */
export async function resolveConnectionProxyConfig(
  providerSpecificData: AccountProxyFields | null | undefined = {},
  provider?: string,
): Promise<ResolvedProxy> {
  try {
    const settings = await getSettings();
    const strategies = (settings.providerStrategies || {}) as Record<string, { proxyPoolId?: unknown } | undefined>;
    const layers = {
      account: providerSpecificData || {},
      provider: provider ? strategies[provider]?.proxyPoolId : null,
      global: settings.globalProxyPoolId,
    };
    const pools: Record<string, ProxyPoolLike | null> = {};
    for (const id of chainPoolIds(layers)) {
      if (!(id in pools)) pools[id] = (await getProxyPoolById(id)) as ProxyPoolLike | null;
    }
    return resolveProxyChain({ ...layers, pools });
  } catch (error) {
    console.error("[resolveConnectionProxyConfig] Failed to resolve proxy config:", error);
    // Fail closed: a request must not silently skip a proxy it was meant to use.
    return {
      ...resolveProxyChain({ pools: {} }),
      source: "error",
      strictProxy: true,
      blockedReason: "Could not resolve the proxy for this account",
    };
  }
}
