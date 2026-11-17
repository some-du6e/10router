import { randomBytes } from "node:crypto";

// Deployed relays (Cloudflare, Vercel, Deno) are public URLs. Each one gets a
// random key baked into its code, and the pool stores the relay URL with the
// key as a query parameter, so only this gateway can use the relay.
export const RELAY_KEY_PARAM = "relay_key";

export function newRelayKey(): string {
  return randomBytes(24).toString("base64url");
}

export function withRelayKey(url: string, key: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set(RELAY_KEY_PARAM, key);
  return parsed.toString();
}

// Relay-side source: a block that answers 403 unless `requestVar` carries the key.
export function relayKeyCheck(key: string, requestVar: string): string {
  return `{
    const got = new URL(${requestVar}.url).searchParams.get(${JSON.stringify(RELAY_KEY_PARAM)}) || "";
    const want = ${JSON.stringify(key)};
    let diff = got.length ^ want.length;
    for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ (got.charCodeAt(i) || 0);
    if (diff !== 0) return new Response("Forbidden", { status: 403 });
  }`;
}
