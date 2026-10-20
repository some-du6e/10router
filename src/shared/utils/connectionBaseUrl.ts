// Per-key base URLs for compatible nodes. One provider (one prefix) can have
// keys on different accounts or regions of the same API: each key may carry
// its own providerSpecificData.baseUrl, flagged ownBaseUrl, and the key pool's
// failover then fails over between endpoints. Node edits leave such keys'
// URLs alone.
import { assertPublicUrlResolved } from "./ssrfGuard.js";

// API paths people paste along with the base URL. The executor appends them.
const TRAILING_API_PATH = /\/(chat\/completions|messages|responses)$/i;

// Trim, drop trailing slashes and a pasted API path, keep any query string
// (Azure's ?api-version=).
export function normalizeEndpointUrl(raw: unknown): string {
  const s = String(raw ?? "").trim();
  const q = s.indexOf("?");
  let base = q === -1 ? s : s.slice(0, q);
  for (let prev = ""; prev !== base;) {
    prev = base;
    base = base.replace(/\/+$/, "").replace(TRAILING_API_PATH, "");
  }
  return q === -1 ? base : `${base}${s.slice(q)}`;
}

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

  let parsed: URL;
  try { parsed = new URL(wanted); } catch { return { ok: false, error: "Endpoint URL isn't a valid URL" }; }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, error: "Endpoint URL must start with http:// or https://" };
  }
  if (remote) {
    try { await assertPublicUrlResolved(wanted); }
    catch { return { ok: false, error: "URL not allowed" }; }
  }
  return { ok: true, baseUrl: wanted, own: true };
}

// Apply a resolved URL to a key's providerSpecificData.
export function withKeyBaseUrl<T extends Record<string, unknown>>(psd: T, result: { baseUrl: string; own: boolean }): T {
  const next: Record<string, unknown> = { ...psd, baseUrl: result.baseUrl };
  if (result.own) next.ownBaseUrl = true;
  else delete next.ownBaseUrl;
  return next as T;
}
