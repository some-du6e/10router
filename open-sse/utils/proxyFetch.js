import { HTTP_STATUS, MEMORY_CONFIG, UNDICI_HEADERS_TIMEOUT_MS } from "../config/runtimeConfig.js";
import { isUndiciHeadersTimeout } from "./headersTimeout.js";
import { isInvalidHeaderValueError, sanitizeSecrets } from "./redact.js";

const originalFetch = globalThis.fetch;
const proxyDispatchers = new Map();

// ─── TLS fingerprinting via got-scraping (browser-like JA3) ───────────────
// Disabled: not in use. Kept commented for future re-enable.
// Restore the original block to re-enable per-host JA3 spoofing.
/*
let _gotScraping = null;
let _gotScrapingChecked = false;
const _gotScrapingLoggedHosts = new Set();

async function getGotScraping() {
  if (_gotScrapingChecked) return _gotScraping;
  _gotScrapingChecked = true;
  try {
    const mod = await import("got-scraping");
    _gotScraping = typeof mod.gotScraping === "function" ? mod.gotScraping : null;
    if (_gotScraping) dbg("TLS", "got-scraping loaded (browser-like JA3 enabled)");
  } catch (e) {
    console.warn(`[ProxyFetch] got-scraping unavailable, falling back to native fetch: ${e.message}`);
    _gotScraping = null;
  }
  return _gotScraping;
}

async function gotScrapingFetch(url, options) {
  const gs = await getGotScraping();
  if (!gs) return null;

  const method = (options.method || "GET").toUpperCase();
  const headersInit = options.headers || {};
  const headers = headersInit instanceof Headers
    ? Object.fromEntries(headersInit.entries())
    : { ...headersInit };

  return new Promise((resolve, reject) => {
    let settled = false;
    const stream = gs.stream({
      url,
      method,
      headers,
      body: method === "GET" || method === "HEAD" ? undefined : options.body,
      throwHttpErrors: false,
      retry: { limit: 0 },
      timeout: { request: undefined },
      followRedirect: false,
      decompress: true,
    });

    if (options.signal) {
      const onAbort = () => { try { stream.destroy(new Error("aborted")); } catch { } };
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener("abort", onAbort, { once: true });
    }

    stream.once("response", (res) => {
      if (settled) return;
      settled = true;
      const resHeaders = new Headers();
      for (const [k, v] of Object.entries(res.headers || {})) {
        if (Array.isArray(v)) v.forEach((x) => resHeaders.append(k, String(x)));
        else if (v != null) resHeaders.set(k, String(v));
      }
      const body = Readable.toWeb(stream);
      resolve(new Response(body, { status: res.statusCode, statusText: res.statusMessage || "", headers: resHeaders }));
    });

    stream.once("error", (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}

async function tryGotScrapingFetch(url, options) {
  try {
    const res = await gotScrapingFetch(url, options);
    if (res) {
      try {
        const host = new URL(typeof url === "string" ? url : url.toString()).hostname;
        if (!_gotScrapingLoggedHosts.has(host)) {
          _gotScrapingLoggedHosts.add(host);
          dbg("TLS", `using got-scraping for ${host}`);
        }
      } catch { }
    }
    return res;
  } catch (e) {
    console.warn(`[ProxyFetch] got-scraping request failed, fallback to native fetch: ${e.message}`);
    return null;
  }
}
*/

function normalizeString(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

function shouldBypassByNoProxy(targetUrl, noProxyValue) {
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

/**
 * Get proxy URL from environment
 */
function getEnvProxyUrl(targetUrl) {
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

/**
 * Normalize proxy URL (allow host:port)
 */
function normalizeProxyUrl(proxyUrl) {
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

function resolveConnectionProxyUrl(targetUrl, proxyOptions) {
  const enabled = proxyOptions?.enabled === true || proxyOptions?.connectionProxyEnabled === true;
  if (!enabled) return null;

  const proxyUrlRaw = normalizeString(proxyOptions?.url ?? proxyOptions?.connectionProxyUrl);
  if (!proxyUrlRaw) return null;

  const noProxy = normalizeString(proxyOptions?.noProxy ?? proxyOptions?.connectionNoProxy);
  if (noProxy && shouldBypassByNoProxy(targetUrl, noProxy)) return null;

  return normalizeProxyUrl(proxyUrlRaw);
}

/**
 * Create proxy dispatcher lazily (undici-compatible)
 */
async function getDispatcher(proxyUrl, { noHeadersTimeout = false } = {}) {
  const normalized = normalizeProxyUrl(proxyUrl);
  if (!normalized) return null;
  const key = noHeadersTimeout ? `${normalized}#no-headers-timeout` : normalized;

  if (!proxyDispatchers.has(key)) {
    // Evict oldest entry if max size reached
    if (proxyDispatchers.size >= MEMORY_CONFIG.proxyDispatchersMaxSize) {
      proxyDispatchers.delete(proxyDispatchers.keys().next().value);
    }
    const { ProxyAgent } = await import("undici");
    proxyDispatchers.set(key, new ProxyAgent({ uri: normalized, ...(noHeadersTimeout ? { headersTimeout: 0 } : {}) }));
  }

  return proxyDispatchers.get(key);
}

// A direct dispatcher with undici's headers timeout off, for a fetch whose own
// timer allows longer (see proxyAwareFetch). Built once; null if undici can't load.
let directDispatcher;
async function getDirectDispatcher() {
  if (directDispatcher === undefined) {
    try {
      const { Agent } = await import("undici");
      directDispatcher = new Agent({ headersTimeout: 0 });
    } catch (error) {
      console.warn(`[ProxyFetch] undici unavailable (${error.message}); long header waits end at its default ${UNDICI_HEADERS_TIMEOUT_MS / 1000}s`);
      directDispatcher = null;
    }
  }
  return directDispatcher;
}

// Node's fetch (undici) clones a request it may redirect: it tees the body, sends
// one branch and leaves the other unread, so a copy of the whole body stays
// queued off the JS heap until the response ends (a stream: minutes). With
// redirect "error" it sends the request itself (window: null is already the case
// in Node). A body that can be sent again goes out that way, and the request is
// sent again as the caller asked when the upstream answers with a redirect
// (which that follows) or a 421 (which fetch retries by re-sending a byte body
// it has already sent, so it fails with a length mismatch; a large string or
// byte body is sent as a stream, below, which fetch doesn't retry). Neither reply means the
// upstream acted on the request. Bun's fetch fails these differently, so this is
// Node only.
const SEND_WITHOUT_CLONE = Boolean(process.versions?.undici) && !process.versions?.bun;
const UNDICI_REDIRECT_ERROR = "unexpected redirect";
const UNDICI_LENGTH_MISMATCH = "UND_ERR_REQ_CONTENT_LENGTH_MISMATCH";

function canSendAgain(body) {
  return typeof body === "string" || body instanceof ArrayBuffer || ArrayBuffer.isView(body) || body instanceof URLSearchParams;
}

function needsTheClone(error) {
  return error?.name === "TypeError" && (error.cause?.message === UNDICI_REDIRECT_ERROR || error.cause?.code === UNDICI_LENGTH_MISMATCH);
}

// fetch also keeps a string body on its request until the response ends (the
// source it would send again), so a streamed reply kept its whole prompt for
// minutes. The string goes out as a stream of its UTF-8 bytes instead, with the
// same Content-Length and Content-Type fetch would send, and nothing of it is
// left once it is written. A byte body (any Uint8Array: an executor's encoded
// body, which it keeps only until a reply starts to resend it to another
// account, or the binary bodies Windsurf, Qoder and a proxied Cursor send) goes
// out the same way, as it is, so fetch keeps no hold on it either. Only a body of
// MEMORY_CONFIG.streamedBodyMinChars or more (characters or bytes), on a
// method that has one.
function streamedOnce(init) {
  const method = String(init.method || "GET").toUpperCase();
  const text = typeof init.body === "string";
  if (!(text || init.body instanceof Uint8Array) || init.body.length < MEMORY_CONFIG.streamedBodyMinChars || method === "GET" || method === "HEAD") return null;
  let source = init.body;
  const headers = new Headers(init.headers);
  headers.set("content-length", String(text ? Buffer.byteLength(source, "utf8") : source.byteLength));
  // What fetch itself sends with a string body and none set; a byte body gets none.
  if (text && !headers.has("content-type")) headers.set("content-type", "text/plain;charset=UTF-8");
  const body = new ReadableStream({
    pull(controller) {
      controller.enqueue(text ? Buffer.from(source, "utf8") : source);
      source = null;
      controller.close();
    },
  });
  return { ...init, body, duplex: "half", headers };
}

async function send(target, init) {
  if (!SEND_WITHOUT_CLONE || !init || init.redirect !== undefined || "window" in init || !canSendAgain(init.body)) {
    return originalFetch(target, init);
  }
  const streamed = streamedOnce(init);
  try {
    const response = await originalFetch(target, { ...(streamed || init), redirect: "error", window: null });
    // fetch re-sends a string body on a 421 by itself, but not a stream: the
    // request goes again as the caller asked, which fetch handles as before.
    if (streamed && response.status === HTTP_STATUS.MISDIRECTED_REQUEST) {
      response.body?.cancel().catch(() => { });
      return originalFetch(target, init);
    }
    return response;
  } catch (error) {
    if (!needsTheClone(error)) throw error;
    return originalFetch(target, init);
  }
}

// An optional observer the app installs on globalThis (the custom-endpoint
// request log, src/lib/endpointRequestLog.ts, on runtimes whose undici lacks the
// body diagnostics channels). Kept as a global so the engine imports nothing
// from the app.
const FETCH_TAP = Symbol.for("10router.fetchTap");

// headersTimeoutMs: the caller's own limit on waiting for response headers. At
// UNDICI_HEADERS_TIMEOUT_MS or more, undici's would end the fetch first, so the
// fetch goes through a dispatcher with it off.
export async function proxyAwareFetch(url, options = {}, proxyOptions = null, { headersTimeoutMs = 0 } = {}) {
  const noHeadersTimeout = headersTimeoutMs >= UNDICI_HEADERS_TIMEOUT_MS;
  const tap = globalThis[FETCH_TAP];
  const seen = tap ? tap.start(typeof url === "string" ? url : url.toString(), options) : null;
  if (!seen) return fetchVia(url, options, proxyOptions, noHeadersTimeout);
  try {
    return seen.done(await fetchVia(url, options, proxyOptions, noHeadersTimeout));
  } catch (error) {
    seen.fail(error);
    throw error;
  }
}

async function fetchVia(url, options, proxyOptions, noHeadersTimeout = false) {
  const targetUrl = typeof url === "string" ? url : url.toString();
  const direct = async (target, init) => {
    const dispatcher = noHeadersTimeout ? await getDirectDispatcher() : null;
    return send(target, dispatcher ? { ...init, dispatcher } : init);
  };

  // Vercel relay: forward request via relay headers
  const vercelRelayUrl = normalizeString(proxyOptions?.vercelRelayUrl);
  if (vercelRelayUrl) {
    const parsed = new URL(targetUrl);
    const relayHeaders = {
      ...options.headers,
      "x-relay-target": `${parsed.protocol}//${parsed.host}`,
      "x-relay-path": `${parsed.pathname}${parsed.search}`,
    };
    return direct(vercelRelayUrl, { ...options, headers: relayHeaders });
  }

  const connectionProxyUrl = resolveConnectionProxyUrl(targetUrl, proxyOptions);
  const envProxyUrl = connectionProxyUrl ? null : normalizeProxyUrl(getEnvProxyUrl(targetUrl));
  const proxyUrl = connectionProxyUrl || envProxyUrl;

  if (proxyUrl) {
    try {
      const dispatcher = await getDispatcher(proxyUrl, { noHeadersTimeout });
      return await send(url, { ...options, dispatcher });
    } catch (proxyError) {
      // The caller aborted (a client hang-up, or its own timer): not the proxy
      // failing. Passed on as is, so it still reads as an abort.
      if (proxyError?.name === "AbortError" || options?.signal?.aborted) throw proxyError;
      // The upstream got the request and sent no headers (undici's own limit,
      // which a SOCKS proxy keeps): not the proxy failing, so not retried direct.
      if (isUndiciHeadersTimeout(proxyError)) throw proxyError;
      // A refused header value fails direct too, and its message quotes the
      // value (a bearer token, say): pass it on without logging or retrying.
      if (isInvalidHeaderValueError(proxyError)) throw proxyError;
      const reason = sanitizeSecrets(proxyError.message);
      // If strictProxy is enabled, fail hard instead of falling back to direct
      if (proxyOptions?.strictProxy === true) {
        // Callers classify by the cause, so it stays, unless redaction changed
        // its text: then a copy with the redacted text, name and code stands in.
        const cause = reason === proxyError.message
          ? proxyError
          : Object.assign(new Error(reason), { name: proxyError.name, code: proxyError.code });
        throw new Error(`[ProxyFetch] Proxy required but failed (strictProxy=true): ${reason}`, { cause });
      }
      console.warn(`[ProxyFetch] Proxy failed, falling back to direct: ${reason}`);
      return direct(url, options);
    }
  }

  // got-scraping disabled — use native fetch directly
  // (Re-enable per-host by wrapping with tryGotScrapingFetch when needed)
  return direct(url, options);
}

/**
 * Patched global fetch with env-proxy support
 */
async function patchedFetch(url, options = {}) {
  return proxyAwareFetch(url, options, null);
}

// Idempotency guard — only patch once to avoid wrapping multiple times
if (globalThis.fetch !== patchedFetch) {
  globalThis.fetch = patchedFetch;
}

export default patchedFetch;
