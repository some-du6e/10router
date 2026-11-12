/**
 * The 10router API key a client sent, from wherever its SDK puts it:
 * `Authorization: Bearer`, Anthropic's `x-api-key`, Google's `x-goog-api-key`,
 * or Google's `?key=` query parameter. The middleware and the /v1 handlers
 * both read it here, so a key the middleware lets through is the key the
 * handler checks limits on and records spend against.
 *
 * @param {Request} request a Request or NextRequest
 * @returns {string|null}
 */
export function extractClientApiKey(request) {
  const headers = request?.headers;
  if (!headers?.get) return null;
  const authHeader = headers.get("Authorization");
  if (authHeader?.startsWith("Bearer ")) return authHeader.slice(7);
  const apiKeyHeader = headers.get("x-api-key");
  if (apiKeyHeader) return apiKeyHeader;
  const googleApiKeyHeader = headers.get("x-goog-api-key");
  if (googleApiKeyHeader) return googleApiKeyHeader;
  let params = request.nextUrl?.searchParams;
  if (!params && request.url) {
    try { params = new URL(request.url).searchParams; } catch { params = null; }
  }
  return params?.get("key") || null;
}
