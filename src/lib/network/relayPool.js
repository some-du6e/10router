import { createProxyPool, getProxyPools, updateProxyPool } from "@/models";
import { withRelayKey } from "./relayKey.js";

const originOf = (url) => {
  try { return new URL(url).origin; } catch { return null; }
};

// Store a relay just deployed with `relayKey` baked in. Redeploying a
// Cloudflare worker under the same name replaces its code (and so its key) at
// the same URL, so every pool row of that type on that URL gets the new key
// instead of a second row being added; the old row would answer 403 from then
// on. Vercel deployments get a new URL each time and Deno refuses a name
// that's taken, so for them this always adds a row.
export async function saveRelayPool({ type, name, deployUrl, relayKey }) {
  const proxyUrl = withRelayKey(deployUrl, relayKey);
  const origin = originOf(deployUrl);
  const same = (await getProxyPools({})).filter((p) => p.type === type && originOf(p.proxyUrl) === origin);
  if (!same.length) {
    const proxyPool = await createProxyPool({ name, proxyUrl, type, noProxy: "", isActive: true, strictProxy: false });
    return { proxyPool, created: true };
  }
  // Only the URL changes: a pool the operator switched off stays off.
  const updated = await Promise.all(same.map((pool) => updateProxyPool(pool.id, { proxyUrl })));
  return { proxyPool: updated[0], created: false };
}
