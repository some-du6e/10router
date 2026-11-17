// The outbound proxy the environment sets (HTTPS_PROXY, HTTP_PROXY, ALL_PROXY,
// NO_PROXY, any case), shared by proxyFetch and the SSRF-checked fetches.
import { ProxyAgent } from "undici";

function normalizeString(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

export function shouldBypassByNoProxy(targetUrl, noProxyValue) {
  const noProxy = normalizeString(noProxyValue);
  if (!noProxy) return false;

  let hostname;
  try { hostname = new URL(targetUrl).hostname.toLowerCase(); } catch { return false; }
  const patterns = noProxy.split(",").map((p) => p.trim().toLowerCase()).filter(Boolean);

  return patterns.some((pattern) => {
    if (pattern === "*") return true;
    if (pattern.startsWith(".")) return hostname.endsWith(pattern) || hostname === pattern.slice(1);
    return hostname === pattern || hostname.endsWith(`.${pattern}`);
  });
}

/** The proxy URL the environment sets for targetUrl, as written, or undefined/null. */
export function getEnvProxyUrl(targetUrl) {
  const noProxy = process.env.NO_PROXY || process.env.no_proxy;
  if (shouldBypassByNoProxy(targetUrl, noProxy)) return null;

  let protocol;
  try { protocol = new URL(targetUrl).protocol; } catch { return null; }

  if (protocol === "https:") {
    return process.env.HTTPS_PROXY || process.env.https_proxy ||
      process.env.ALL_PROXY || process.env.all_proxy;
  }

  return process.env.HTTP_PROXY || process.env.http_proxy ||
    process.env.ALL_PROXY || process.env.all_proxy;
}

/** Normalize a proxy URL, allowing a bare host:port. */
export function normalizeProxyUrl(proxyUrl) {
  const normalizedInput = normalizeString(proxyUrl);
  if (!normalizedInput) return null;
  try {
    new URL(normalizedInput);
    return normalizedInput;
  } catch {
    // Allow "127.0.0.1:7890" style values
    return `http://${normalizedInput}`;
  }
}

const agents = new Map();

/** A shared undici dispatcher for the environment's proxy for targetUrl, or null when none applies. */
export function envProxyDispatcher(targetUrl) {
  const uri = normalizeProxyUrl(getEnvProxyUrl(targetUrl));
  if (!uri) return null;
  if (!agents.has(uri)) agents.set(uri, new ProxyAgent({ uri }));
  return agents.get(uri);
}
