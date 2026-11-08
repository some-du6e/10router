// Per-key base URLs for compatible nodes. One provider (one prefix) can have
// keys on different accounts or regions of the same API: each key may carry
// its own providerSpecificData.baseUrl, flagged ownBaseUrl, and the key pool's
// failover then fails over between endpoints. Node edits leave such keys'
// URLs alone.
import { assertPublicUrlResolved } from "./ssrfGuard.js";
import { normalizeEndpointUrl } from "./endpointUrl.js";

export { normalizeEndpointUrl };

export type KeyBaseUrlResult =
  | { ok: true; baseUrl: string; own: boolean }
  | { ok: false; error: string };

// Work out the base URL a key should use. Empty input, or the node's own URL,
// means "use the provider's URL" (own: false). Anything else must be an
// http(s) URL, and for remote callers must not point at an internal host.
export async function resolveKeyBaseUrl(
  input: unknown,
  nodeBaseUrl: string | null | undefined,
  { remote }: { remote: boolean },
): Promise<KeyBaseUrlResult> {
  const nodeUrl = normalizeEndpointUrl(nodeBaseUrl);
  const wanted = normalizeEndpointUrl(input);
  if (!wanted || wanted === nodeUrl) return { ok: true, baseUrl: String(nodeBaseUrl || ""), own: false };

  const problem = await endpointUrlProblem(wanted, { remote });
  if (problem) return { ok: false, error: problem };
  return { ok: true, baseUrl: wanted, own: true };
}

// Null when url can be stored as an endpoint (a key's or a node's); otherwise
// the reason. Remote callers may not point at an internal host.
export async function endpointUrlProblem(url: string, { remote }: { remote: boolean }): Promise<string | null> {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return "Endpoint URL isn't a valid URL"; }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return "Endpoint URL must start with http:// or https://";
  }
  if (remote) {
    try { await assertPublicUrlResolved(url); }
    catch { return "URL not allowed"; }
  }
  return null;
}

// Apply a resolved URL to a key's providerSpecificData.
export function withKeyBaseUrl<T extends Record<string, unknown>>(psd: T, result: { baseUrl: string; own: boolean }): T {
  const next: Record<string, unknown> = { ...psd, baseUrl: result.baseUrl };
  if (result.own) next.ownBaseUrl = true;
  else delete next.ownBaseUrl;
  return next as T;
}

// Drop the per-key URL fields from client-sent providerSpecificData, so the
// only way to set them is the checked baseUrl field (resolveKeyBaseUrl).
// Otherwise a remote caller could store an internal URL and skip the SSRF guard.
export function withoutKeyBaseUrl<T>(psd: T): T {
  if (!psd || typeof psd !== "object" || Array.isArray(psd)) return psd;
  const { baseUrl: _baseUrl, ownBaseUrl: _own, ...rest } = psd as Record<string, unknown>;
  return rest as T;
}
