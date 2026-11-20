import { HTTP_STATUS, RETRY_CONFIG, DEFAULT_RETRY_CONFIG, resolveRetryEntry, upstreamHeadersBudget } from "../config/runtimeConfig.js";
import { headersTimer } from "../utils/headersTimeout.js";
import { shouldRefreshCredentials } from "../services/oauthCredentialManager.js";
import { proxyAwareFetch } from "../utils/proxyFetch.js";
import { dbg } from "../utils/debugLog.js";
import { ANTHROPIC_API_VERSION, OPENAI_COMPAT_BASE, ANTHROPIC_COMPAT_BASE } from "../providers/shared.js";
import { appendUrlPath, resolveOpenAICompatibleApiType } from "../services/provider.js";
import { betaFlagsKey, inlineToolChangesWithoutBeta } from "../utils/anthropicBeta.js";

// What `describe` says `method` reads, called on `executor`. null when the
// executor runs a `method` other than the one defined next to `describe`
// (a subclass or instance override that doesn't restate it).
function statedInputs(executor, describe, method, args) {
  let owner = executor;
  while (owner && !Object.hasOwn(owner, describe)) owner = Object.getPrototypeOf(owner);
  if (!owner || !Object.hasOwn(owner, method) || executor[method] !== owner[method]) return null;
  return owner[describe].apply(executor, args);
}

// One built body: the object (for request logs) and, once serialized, the
// exact string sent.
function builtBody(value, key = null, source = null) {
  return {
    key, source, value, text: null,
    serialize() {
      if (this.text === null) this.text = JSON.stringify(this.value);
      return this.text;
    },
  };
}

/**
 * BaseExecutor - Base class for provider executors
 */
export class BaseExecutor {
  constructor(provider, config) {
    this.provider = provider;
    this.config = config;
    this.noAuth = config?.noAuth || false;
  }

  getProvider() {
    return this.provider;
  }

  getBaseUrls() {
    return this.config.baseUrls || (this.config.baseUrl ? [this.config.baseUrl] : []);
  }

  getFallbackCount() {
    return this.getBaseUrls().length || 1;
  }

  buildUrl(model, stream, urlIndex = 0, credentials = null) {
    if (this.provider?.startsWith?.("openai-compatible-")) {
      const baseUrl = credentials?.providerSpecificData?.baseUrl || OPENAI_COMPAT_BASE;
      const path = resolveOpenAICompatibleApiType(this.provider, credentials) === "responses" ? "/responses" : "/chat/completions";
      return appendUrlPath(baseUrl, path);
    }
    if (this.provider?.startsWith?.("anthropic-compatible-")) {
      const baseUrl = credentials?.providerSpecificData?.baseUrl || ANTHROPIC_COMPAT_BASE;
      return appendUrlPath(baseUrl, "/messages");
    }
    const baseUrls = this.getBaseUrls();
    return baseUrls[urlIndex] || baseUrls[0] || this.config.baseUrl;
  }

  buildHeaders(credentials, stream = true) {
    const headers = {
      "Content-Type": "application/json",
      ...this.config.headers
    };

    if (this.provider?.startsWith?.("anthropic-compatible-")) {
      // Anthropic-compatible providers use x-api-key header
      if (credentials.apiKey) {
        headers["x-api-key"] = credentials.apiKey;
      } else if (credentials.accessToken) {
        headers["Authorization"] = `Bearer ${credentials.accessToken}`;
      }
      if (!headers["anthropic-version"]) {
        headers["anthropic-version"] = ANTHROPIC_API_VERSION;
      }
    } else {
      // Standard Bearer token auth for other providers
      if (credentials.accessToken) {
        headers["Authorization"] = `Bearer ${credentials.accessToken}`;
      } else if (credentials.apiKey) {
        headers["Authorization"] = `Bearer ${credentials.apiKey}`;
      }
    }

    if (stream) {
      headers["Accept"] = "text/event-stream";
    }

    return headers;
  }

  // Override in subclass for provider-specific transformations
  transformRequest(model, body, stream, credentials) {
    return body;
  }

  // Last change to the body, once the outgoing headers are final (e.g. drop a
  // field whose beta flag isn't going out). Called by execute() below for
  // each body it builds, with that send's headers; by the Translator preview
  // with the headers it shows; and by chatCore with headers = null for its
  // error log. An executor that overrides execute() and sends Claude-format
  // bodies must call it itself.
  // Here: mid-conversation tool changes go out only with a beta that allows
  // them; otherwise they're folded into tools[].
  finalizeBody(body, headers, credentials) {
    return inlineToolChangesWithoutBeta(body, headers);
  }

  // What transformRequest and finalizeBody read besides the body, the model
  // and the stream flag, as strings: equal strings mean the same bytes go out,
  // so a resend (retry, next base URL, the send after a token refresh) reuses
  // the serialized body. null: unknown, the body is built for every send. A
  // class that overrides either method without restating its inputs next to it
  // gets null (see statedInputs).
  transformRequestInputs(model, stream, credentials) {
    return "";
  }

  finalizeBodyInputs(headers, credentials) {
    return betaFlagsKey(headers);
  }

  // The headers and body for one send. `cache` (one per account's request)
  // holds the last body built; it is handed back while its key and source body
  // are the same. Executors with unknown inputs keep the old order, transform
  // before headers (some set state there that buildHeaders reads), and a fresh
  // body every send.
  prepareSend({ model, body, stream, credentials, url, cache }) {
    const transformInputs = statedInputs(this, "transformRequestInputs", "transformRequest", [model, stream, credentials]);
    if (transformInputs == null) {
      const transformed = this.transformRequest(model, body, stream, credentials);
      const headers = this.buildHeaders(credentials, stream, url, model);
      return { headers, built: builtBody(this.finalizeBody(transformed, headers, credentials)) };
    }
    const headers = this.buildHeaders(credentials, stream, url, model);
    const finalizeInputs = statedInputs(this, "finalizeBodyInputs", "finalizeBody", [headers, credentials]);
    const key = finalizeInputs == null ? null : JSON.stringify([this.provider, model, stream, transformInputs, finalizeInputs]);
    const last = cache.last;
    if (key !== null && last?.key === key && last.source === body) return { headers, built: last };
    const built = builtBody(this.finalizeBody(this.transformRequest(model, body, stream, credentials), headers, credentials), key, body);
    if (key !== null) cache.last = built;
    return { headers, built };
  }

  shouldRetry(status, urlIndex) {
    return status === HTTP_STATUS.RATE_LIMITED && urlIndex + 1 < this.getFallbackCount();
  }

  // Override in subclass for provider-specific refresh
  async refreshCredentials(credentials, log, proxyOptions = null) {
    return null;
  }

  needsRefresh(credentials) {
    return shouldRefreshCredentials(this.provider, credentials);
  }

  parseError(response, bodyText) {
    return { status: response.status, message: bodyText || `HTTP ${response.status}` };
  }

  // `onUpstreamAttempt(ts)`: when the attempt now in flight was sent, or 0 when
  // none is (backing off before a retry, or the last attempt came back with an
  // error). A client that hangs up is charged only while one is in flight.
  // `bodyCache`: chatCore's, so the send after a token refresh can reuse this
  // call's body; without one, reuse stays within this call.
  async execute({ model, body, stream, credentials, signal, log, proxyOptions = null, onHeadersBudget = null, onUpstreamAttempt = null, bodyCache = null }) {
    const cache = bodyCache || {};
    const fallbackCount = this.getFallbackCount();
    // How long each URL waits for response headers; the caller learns the
    // whole call's (a hung model's probe goes by it).
    const { ms: timeoutMs, setBy } = upstreamHeadersBudget({ stream, timeoutMs: this.config?.timeoutMs, attempts: this.config?.headersTimeoutAttempts });
    onHeadersBudget?.(timeoutMs * fallbackCount);
    let lastError = null;
    let lastStatus = 0;
    const retryAttemptsByUrl = {};

    // Merge default retry config with provider-specific config
    const retryConfig = { ...DEFAULT_RETRY_CONFIG, ...this.config.retry };

    // Schedule retry via retryConfig[statusKey]. Returns true when caller should `urlIndex--; continue`
    // response (optional) lets a subclass hook compute a dynamic delay (e.g. antigravity Retry-After).
    const tryRetry = async (urlIndex, statusKey, reason, response = null) => {
      const { attempts, delayMs } = resolveRetryEntry(retryConfig[statusKey]);
      if (attempts <= 0 || retryAttemptsByUrl[urlIndex] >= attempts) return false;
      // Hook: subclass may derive delay from the response (headers/body). null → skip retry, use fallback.
      let waitMs = delayMs;
      if (response && this.computeRetryDelay) {
        const dynamic = await this.computeRetryDelay(response, retryAttemptsByUrl[urlIndex] + 1, delayMs);
        if (dynamic === false) return false; // hook vetoes retry (e.g. Retry-After too long)
        if (dynamic != null) waitMs = dynamic;
      }
      retryAttemptsByUrl[urlIndex]++;
      log?.debug?.("RETRY", `${reason} retry ${retryAttemptsByUrl[urlIndex]}/${attempts} after ${waitMs / 1000}s`);
      onUpstreamAttempt?.(0);
      await new Promise(resolve => setTimeout(resolve, waitMs));
      return true;
    };

    for (let urlIndex = 0; urlIndex < fallbackCount; urlIndex++) {
      const url = this.buildUrl(model, stream, urlIndex, credentials);
      const { headers, built } = this.prepareSend({ model, body, stream, credentials, url, cache });
      const transformedBody = built.value;

      if (!retryAttemptsByUrl[urlIndex]) retryAttemptsByUrl[urlIndex] = 0;

      // Abort if upstream doesn't return response headers in time
      const headersTimeout = headersTimer(timeoutMs, signal, { stream, setBy });

      try {
        const bodyStr = built.serialize();
        const fetchT0 = Date.now();
        dbg("FETCH", `${this.provider.toUpperCase()} → ${url} | body=${bodyStr.length}B | headersTimeout=${timeoutMs}ms`);
        onUpstreamAttempt?.(signal?.aborted ? 0 : fetchT0);
        const response = await proxyAwareFetch(url, {
          method: "POST",
          headers,
          body: bodyStr,
          signal: headersTimeout.signal
        }, proxyOptions, { headersTimeoutMs: timeoutMs });
        headersTimeout.clear();
        const ct = response.headers?.get?.("content-type") || "";
        const cl = response.headers?.get?.("content-length") || "?";
        dbg("FETCH", `${this.provider.toUpperCase()} ← ${response.status} | ttft=${Date.now() - fetchT0}ms | ct=${ct} | cl=${cl}`);

        if (await tryRetry(urlIndex, response.status, `status ${response.status}`, response)) { urlIndex--; continue; }

        if (!response.ok) onUpstreamAttempt?.(0);
        if (this.shouldRetry(response.status, urlIndex)) {
          log?.debug?.("RETRY", `${response.status} on ${url}, trying fallback ${urlIndex + 1}`);
          lastStatus = response.status;
          continue;
        }

        return { response, url, headers, transformedBody };
      } catch (caught) {
        headersTimeout.clear();
        const timedOut = headersTimeout.error(caught);
        const error = timedOut || caught;
        // Request logs keep what was (or would have been) sent, not the pre-transform body.
        // Non-enumerable, so logging the error doesn't print the prompt.
        if (error && typeof error === "object" && Object.isExtensible(error)) {
          Object.defineProperty(error, "transformedBody", { value: transformedBody, enumerable: false, configurable: true, writable: true });
        }
        lastError = error;
        dbg("FETCH", `${this.provider.toUpperCase()} ✖ ${error?.name}: ${error?.message}`);
        // The client hung up: the attempt was in flight.
        if (!timedOut && error?.name === "AbortError") throw error;
        onUpstreamAttempt?.(0);

        // Network/fetch exceptions use the 502 retry config. A header timeout
        // already had its whole budget: only the next base URL is tried.
        if (!timedOut && await tryRetry(urlIndex, HTTP_STATUS.BAD_GATEWAY, `network "${error?.message}"`)) { urlIndex--; continue; }

        if (urlIndex + 1 < fallbackCount) {
          log?.debug?.("RETRY", `Error on ${url}, trying fallback ${urlIndex + 1}`);
          continue;
        }
        throw error;
      }
    }

    throw lastError || new Error(`All ${fallbackCount} URLs failed with status ${lastStatus}`);
  }
}

export default BaseExecutor;
