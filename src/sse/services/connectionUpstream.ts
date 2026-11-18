// Where a key's requests go upstream, as one comparable string. auth.js uses it
// for dead-key evidence and keysShareOneUpstream; the account loop for the
// same-request-error stop.
import { normalizeEndpointUrl } from "@/shared/utils/endpointUrl.js";

// Per-connection fields executors build the upstream URL from: a custom base
// URL, an Azure resource, a region or location in the host, an account or
// project in the path.
const UPSTREAM_FIELDS = ["baseUrl", "azureEndpoint", "region", "location", "accountId", "projectId"] as const;

// One base URL however it's written: scheme and host lowercased, a default port
// and trailing slashes or API paths dropped (normalizeEndpointUrl). Left as
// typed, trimmed, when it doesn't parse.
function canonicalBaseUrl(raw: unknown): string {
  const s = normalizeEndpointUrl(raw);
  try {
    const u = new URL(s);
    return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, "")}${u.search}`;
  } catch {
    return s;
  }
}

/** The upstream a key's providerSpecificData points at. */
export function upstreamOf(psd: Record<string, unknown>): string {
  return JSON.stringify(UPSTREAM_FIELDS.map((f) =>
    f === "baseUrl" ? canonicalBaseUrl(psd[f]) : String(psd[f] ?? "").trim().replace(/\/+$/, "")));
}

/** Where one key's requests go upstream: its base URL, account, region and the like. */
export function connectionUpstream(conn: { providerSpecificData?: Record<string, unknown> } | null | undefined): string {
  return upstreamOf(conn?.providerSpecificData || {});
}
