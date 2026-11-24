import { createProxyPool, getProxyPools, updateProxyPool } from "@/models";
import { withRelayKey } from "./relayKey.js";

// A relay's name (and a Deno organization) becomes a label of its hostname,
// <name>.<subdomain>.workers.dev or <name>.<org>.deno.net, so each must be one
// DNS label: a "#", "?" or "/" would move the stored pool URL to another host.
export function isRelayHostLabel(value) {
  return typeof value === "string" && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(value);
}

export const RELAY_NAME_ERROR = "Use only letters, digits and dashes (up to 63, not at the start or end) for the relay name and organization.";

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
    const proxyPool = await createProxyPool({ name, proxyUrl, type, noProxy: "", isActive: true, strictProxy: true });
    return { proxyPool, created: true };
  }
  // Only the URL changes: a pool the operator switched off stays off.
  const updated = await Promise.all(same.map((pool) => updateProxyPool(pool.id, { proxyUrl })));
  return { proxyPool: updated[0], created: false };
}
