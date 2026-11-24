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

type ProviderData = Record<string, unknown> & {
  connectionProxyEnabled?: unknown;
  connectionProxyUrl?: unknown;
  baseUrl?: unknown;
  azureEndpoint?: unknown;
  overrides?: { proxy?: unknown };
};

// Why a connection's providerSpecificData can't be saved as `sent` (what the
// request sets, merged over `current`, what is stored), or null.
// - A Kiro region or profile ARN goes into an AWS hostname, so the values sent
//   must be real ones.
// - Every URL the connection will use gets the endpoint rule: its proxy (sent
//   either way; checked whenever it changes, even saved switched off, and when
//   a stored one is switched on), its per-endpoint proxy, and a URL its
//   provider sends the key to (baseUrl on a provider that isn't a custom node,
//   such as self-hosted STT/TTS/embeddings or ollama-local; Azure's
//   azureEndpoint). The caller leaves a custom node's baseUrl out of `sent`:
//   that one is the node's, or the checked per-key URL.
// Values already in effect pass, so older settings don't block other edits.
export async function providerDataProblem(
  request: Request,
  provider: string,
  sent: unknown,
  current: ProviderData | null | undefined,
): Promise<{ error: string; field?: string } | null> {
  if (!sent || typeof sent !== "object") return null;
  const d = sent as ProviderData;
  if (provider === "kiro") {
    const problem = kiroProviderDataProblem(d);
    if (problem) return { error: problem };
  }
  const next: ProviderData = { ...(current || {}), ...d };
  const enabling = next.connectionProxyEnabled === true && current?.connectionProxyEnabled !== true;
  const urls: { field: string; value: unknown; stored: unknown; proxy?: boolean; recheck?: boolean }[] = [
    { field: "connectionProxyUrl", value: next.connectionProxyUrl, stored: current?.connectionProxyUrl, proxy: true, recheck: enabling },
    { field: "proxy", value: next.overrides?.proxy, stored: current?.overrides?.proxy, proxy: true },
    { field: "baseUrl", value: next.baseUrl, stored: current?.baseUrl },
    { field: "azureEndpoint", value: next.azureEndpoint, stored: current?.azureEndpoint },
  ];
  for (const { field, value, stored, proxy, recheck } of urls) {
    if (value === undefined || value === null || value === "") continue;
    if (value === stored && !recheck) continue;
    // The runtime reads any value with String(), so an array is a URL too.
    if (typeof value !== "string") return { error: `${field} must be a string`, field };
    if (!value.trim()) continue;
    const problem = proxy ? await proxyUrlProblem(request, value) : await privateUrlRejected(request, value.trim());
    if (problem) return { error: problem, field };
  }
  return null;
}
