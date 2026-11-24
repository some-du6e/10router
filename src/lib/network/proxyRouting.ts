// Which proxy a request leaves through. Layers are checked from the most
// specific down: the account, its provider, Global, and finally the system
// outbound proxy (HTTP(S)_PROXY, applied inside proxyFetch). The first layer
// that names a pool or Direct decides.

/** Layer value meaning "no proxy, and don't look further down". */
export const PROXY_DIRECT = "__direct__";

export type ProxyLayer = "account" | "provider" | "global" | "system";

export interface ProxyPoolLike {
  id: string;
  name?: string;
  proxyUrl?: string;
  noProxy?: string;
  isActive?: boolean;
  strictProxy?: boolean;
  type?: string;
}

export interface ResolvedProxy {
  source: string;
  layer: ProxyLayer;
  proxyPoolId: string | null;
  proxyPool: ProxyPoolLike | null;
  connectionProxyEnabled: boolean;
  connectionProxyUrl: string;
  connectionNoProxy: string;
  strictProxy: boolean;
  vercelRelayUrl: string;
  direct: boolean;
  blockedReason: string;
}

export interface AccountProxyFields {
  proxyPoolId?: unknown;
  connectionProxyEnabled?: unknown;
  connectionProxyUrl?: unknown;
  connectionNoProxy?: unknown;
}

const RELAY_TYPES = new Set(["vercel", "cloudflare", "deno"]);

const str = (v: unknown): string => (v === undefined || v === null ? "" : String(v).trim());

/** A layer's stored value: a pool id, PROXY_DIRECT, or null for Inherit. */
export function normalizeLayerSetting(value: unknown): string | null {
  const s = str(value);
  return !s || s === "__none__" ? null : s;
}

const base = (layer: ProxyLayer, proxyPoolId: string | null = null): ResolvedProxy => ({
  source: "none",
  layer,
  proxyPoolId,
  proxyPool: null,
  connectionProxyEnabled: false,
  connectionProxyUrl: "",
  connectionNoProxy: "",
  strictProxy: false,
  vercelRelayUrl: "",
  direct: false,
  blockedReason: "",
});

function fromPool(id: string, pool: ProxyPoolLike | null | undefined, layer: ProxyLayer): ResolvedProxy {
  const blocked = (reason: string): ResolvedProxy => ({ ...base(layer, id), source: "blocked", proxyPool: pool || null, strictProxy: true, blockedReason: reason });
  if (!pool) return blocked(`Proxy pool ${id} no longer exists`);
  const label = pool.name ? `"${pool.name}"` : id;
  if (pool.isActive !== true) return blocked(`Proxy pool ${label} is turned off`);
  const url = str(pool.proxyUrl);
  if (!url) return blocked(`Proxy pool ${label} has no URL`);

  const shared = { ...base(layer, id), proxyPool: pool, connectionNoProxy: str(pool.noProxy), strictProxy: pool.strictProxy === true };
  // Relays rewrite the request to their own URL instead of tunnelling through it.
  if (pool.type && RELAY_TYPES.has(pool.type)) return { ...shared, source: pool.type, vercelRelayUrl: url };
  return { ...shared, source: "pool", connectionProxyEnabled: true, connectionProxyUrl: url };
}

function fromSetting(value: string, pools: Record<string, ProxyPoolLike | null | undefined>, layer: ProxyLayer): ResolvedProxy {
  if (value === PROXY_DIRECT) return { ...base(layer), source: "direct", direct: true };
  return fromPool(value, pools[value], layer);
}

export interface ProxyChainInput {
  account?: AccountProxyFields | null;
  provider?: unknown;
  global?: unknown;
  pools: Record<string, ProxyPoolLike | null | undefined>;
}

/** Pool ids the chain may need, so the caller can load them up front. */
export function chainPoolIds({ account, provider, global }: Omit<ProxyChainInput, "pools">): string[] {
  return [normalizeLayerSetting(account?.proxyPoolId), normalizeLayerSetting(provider), normalizeLayerSetting(global)]
    .filter((v): v is string => !!v && v !== PROXY_DIRECT);
}

export function resolveProxyChain({ account, provider, global, pools }: ProxyChainInput): ResolvedProxy {
  const accountSetting = normalizeLayerSetting(account?.proxyPoolId);
  if (accountSetting) return fromSetting(accountSetting, pools, "account");

  // A per-account proxy URL from before pools existed still counts as the account's own.
  const legacyUrl = str(account?.connectionProxyUrl);
  if (account?.connectionProxyEnabled === true && legacyUrl) {
    return { ...base("account"), source: "legacy", connectionProxyEnabled: true, connectionProxyUrl: legacyUrl, connectionNoProxy: str(account?.connectionNoProxy) };
  }

  const providerSetting = normalizeLayerSetting(provider);
  if (providerSetting) return fromSetting(providerSetting, pools, "provider");

  const globalSetting = normalizeLayerSetting(global);
  if (globalSetting) return fromSetting(globalSetting, pools, "global");

  return base("system");
}

/** The fields proxyAwareFetch reads, from a resolved config. */
export function toProxyOptions(cfg: Partial<ResolvedProxy> | null | undefined) {
  return {
    connectionProxyEnabled: cfg?.connectionProxyEnabled === true,
    connectionProxyUrl: cfg?.connectionProxyUrl || "",
    connectionNoProxy: cfg?.connectionNoProxy || "",
    vercelRelayUrl: cfg?.vercelRelayUrl || "",
    strictProxy: cfg?.strictProxy === true,
    direct: cfg?.direct === true,
    blockedReason: cfg?.blockedReason || "",
  };
}

// Where an account's traffic leaves from, when that's a proxy: the proxy or
// relay URL, so two pools pointing at one proxy count as one. Accounts of a
// provider with the same exit share an IP. Direct and the system proxy aren't
// counted, since they aren't a per-account choice.
export function proxyExit(r: ResolvedProxy): string | null {
  if (r.source === "blocked" || r.direct || r.layer === "system") return null;
  return str(r.connectionProxyUrl || r.vercelRelayUrl) || null;
}

// The pool each account gets from "Give each its own pool": active pools with a
// URL, in name order, one per account, or null when there aren't enough.
export function oneEachAssignments(accountIds: string[], pools: ProxyPoolLike[]): { id: string; poolId: string }[] | null {
  const seen = new Set<string>();
  // One pool per proxy URL, so no two accounts end up on the same proxy.
  const usable = pools.filter((p) => p.isActive === true && str(p.proxyUrl) && !seen.has(str(p.proxyUrl)) && seen.add(str(p.proxyUrl))).sort((a, b) => String(a.name || a.id).localeCompare(String(b.name || b.id)));
  if (usable.length < accountIds.length) return null;
  return accountIds.map((id, i) => ({ id, poolId: usable[i].id }));
}
