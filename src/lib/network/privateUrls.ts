import { hasSignedInDashboardSession, isLocalRequest } from "@/dashboardGuard";
import { assertPublicUrlResolved } from "@/shared/utils/ssrfGuard.js";
import { PRIVATE_URL_ERROR } from "@/shared/constants/privateUrl.js";
import { kiroProviderDataProblem } from "open-sse/utils/awsRegion.js";
import { normalizeProxyUrl } from "open-sse/utils/envProxy.js";

export const ALLOW_PRIVATE_URLS_ENV = "ALLOW_PRIVATE_ENDPOINT_URLS";
export { PRIVATE_URL_ERROR };

// True when a dashboard request may not point the server at an internal host
// (endpoint, key and proxy URLs, their probes, a GitLab instance). Local
// callers may. So may a signed-in dashboard session when the operator sets
// ALLOW_PRIVATE_ENDPOINT_URLS=true: a session through a reverse proxy, or
// (usually) a Docker published port, never counts as local, yet its model
// servers may sit on the LAN. The management API's internal requests carry no
// session, so they stay strict either way.
export async function blocksPrivateUrls(request: Request): Promise<boolean> {
  if (isLocalRequest(request)) return false;
  if (process.env[ALLOW_PRIVATE_URLS_ENV] !== "true") return true;
  return !(await hasSignedInDashboardSession(request));
}

// PRIVATE_URL_ERROR when this caller may not use url, else null.
export async function privateUrlRejected(request: Request, url: string): Promise<string | null> {
  if (!(await blocksPrivateUrls(request))) return null;
  try {
    await assertPublicUrlResolved(url);
    return null;
  } catch {
    return PRIVATE_URL_ERROR;
  }
}

// A proxy URL (a pool's HTTP/SOCKS proxy or deployed relay, a connection or
// endpoint proxy) as proxyFetch reads it, bare host:port included: null when
// this caller may store or test it.
export async function proxyUrlProblem(request: Request, raw: string): Promise<string | null> {
  const url = normalizeProxyUrl(raw);
  try { new URL(url || ""); } catch { return "Proxy URL isn't a valid URL"; }
  return privateUrlRejected(request, url as string);
}

type ProviderData = Record<string, unknown> & { connectionProxyUrl?: unknown; overrides?: { proxy?: unknown } };

// Why client-sent providerSpecificData for a connection can't be stored, or
// null. A Kiro region or profile ARN goes into an AWS hostname, so it must be
// a real one; a connection proxy URL or per-endpoint proxy the request
// changes gets the same rule as an endpoint URL. Values equal to the stored
// ones (`current`) pass, so older settings don't block other edits.
export async function providerDataProblem(request: Request, provider: string, data: unknown, current: ProviderData | null | undefined): Promise<string | null> {
  if (!data || typeof data !== "object") return null;
  const d = data as ProviderData;
  if (provider === "kiro") {
    const problem = kiroProviderDataProblem(d);
    if (problem) return problem;
  }
  const urls = [
    [d.connectionProxyUrl, current?.connectionProxyUrl],
    [d.overrides?.proxy, current?.overrides?.proxy],
  ];
  for (const [next, stored] of urls) {
    if (typeof next !== "string" || !next.trim() || next === stored) continue;
    const problem = await proxyUrlProblem(request, next);
    if (problem) return problem;
  }
  return null;
}
