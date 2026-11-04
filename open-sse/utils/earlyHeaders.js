// Early stream headers: answer a streaming client before the upstream does.
//
// A proxy in front of 10router (Cloudflare: 524 after ~100-120s) drops a request
// that gets no response headers in time. Account and combo fallback run before
// any headers go out, so one slow upstream, or several in a row, can keep the
// client waiting past that. After `delayMs` this sends 200 + SSE headers and
// keepalive comments while routing carries on server-side, then pipes the real
// stream, or writes the final failure into the stream in the client's format.
import { FORMATS } from "../translator/formats.js";
import { HTTP_STATUS, STREAM_EARLY_HEADERS_MS, STREAM_KEEPALIVE_MS } from "../config/runtimeConfig.js";
import {
  CLAUDE_RETRYABLE_STREAM_ERROR_TYPE, RESPONSES_STREAM_ERROR_CODES,
  SHOULD_RETRY_HEADER, SHOULD_RETRY_NO, DEFAULT_ERROR_MESSAGES,
} from "../config/errorConfig.js";
import { buildStreamErrorBytes } from "./streamHelpers.js";
import { formatIncompleteOpenAIResponsesStreamFailure } from "./responsesStreamHelpers.js";
import { SSE_HEADERS_CORS, SSE_KEEPALIVE } from "./sseConstants.js";

const encoder = new TextEncoder();
const KEEPALIVE_BYTES = encoder.encode(SSE_KEEPALIVE);
const EARLY = Symbol("early");
const MAX_MESSAGE = 2000;

// Should the in-band error ask the client to retry? 408, 409, 429 and 5xx are
// what the Anthropic and OpenAI SDKs (and so Claude Code) retry as HTTP statuses.
// Codex over HTTP retries those too, at the turn level (codex-rs api_bridge.rs
// maps 429 to RetryLimit, 500 to InternalServerError, and any status but 400 to
// UnexpectedStatus, all retried in protocol/src/error.rs retry_delay); it would
// also retry a 401/403/404 there, which in-band we make final instead.
function isRetryableFailure(status, headers = null) {
  if (headers?.get?.(SHOULD_RETRY_HEADER) === SHOULD_RETRY_NO) return false;
  return [HTTP_STATUS.REQUEST_TIMEOUT, HTTP_STATUS.CONFLICT, HTTP_STATUS.RATE_LIMITED].includes(status) || status >= HTTP_STATUS.SERVER_ERROR;
}

/**
 * The final error of a stream whose headers already went out, in the client's
 * own format: Claude `event: error`, Responses `response.failed`, OpenAI
 * `data: {"error":…}` + [DONE]. `code` is the failed body's own error code;
 * Responses keeps it when Codex has a path of its own for it.
 */
export function buildEarlyErrorBytes(status, message, sourceFormat, { retryable = isRetryableFailure(status), code = null } = {}) {
  if (sourceFormat === FORMATS.CLAUDE) {
    return buildStreamErrorBytes(status, message, FORMATS.CLAUDE, retryable ? { type: CLAUDE_RETRYABLE_STREAM_ERROR_TYPE } : {});
  }
  if (sourceFormat === FORMATS.OPENAI_RESPONSES) {
    const codes = RESPONSES_STREAM_ERROR_CODES;
    const own = codes.passthrough.includes(code) ? code : null;
    const fallback = retryable
      ? (status === HTTP_STATUS.RATE_LIMITED ? codes.rateLimited : codes.retryable)
      : codes.final;
    return encoder.encode(formatIncompleteOpenAIResponsesStreamFailure({ code: own || fallback, message }));
  }
  return buildStreamErrorBytes(status, message, FORMATS.OPENAI);
}

async function readFailure(response) {
  const text = await response.text().catch(() => "");
  let message = text;
  let code = null;
  try {
    const err = JSON.parse(text)?.error;
    message = (typeof err?.message === "string" && err.message) || (typeof err === "string" && err) || text;
    if (typeof err?.code === "string") code = err.code;
  } catch { /* plain-text body */ }
  return { message: String(message || `request failed (${response.status})`).slice(0, MAX_MESSAGE), code };
}

// Bytes that end a committed stream for a routing result that isn't a stream.
// A JSON success can't land here: chatCore already replays one as the client's
// stream, so an ok non-stream reply is one it couldn't replay.
async function terminalBytes(response, sourceFormat) {
  if (response.ok) {
    response.body?.cancel().catch(() => {});
    return buildEarlyErrorBytes(HTTP_STATUS.BAD_GATEWAY, "upstream reply was not a stream", sourceFormat);
  }
  const { message, code } = await readFailure(response);
  return buildEarlyErrorBytes(response.status, message, sourceFormat, {
    retryable: isRetryableFailure(response.status, response.headers),
    code,
  });
}

function isEventStream(response) {
  return response.ok && !!response.body &&
    (response.headers.get("content-type") || "").toLowerCase().includes("text/event-stream");
}

/**
 * Run `run(signal)`. If it answers within `delayMs` its Response is returned
 * as is, real status included. Otherwise a 200 SSE Response is returned at
 * `delayMs`, carrying keepalives until `run` settles and then its stream or
 * failure. `signal` aborts when the client hangs up, before or after the
 * headers went out.
 *
 * @param {object} options
 * @param {(signal: AbortSignal) => Promise<Response>} options.run
 * @param {string} options.sourceFormat - client's wire format
 * @param {AbortSignal|null} [options.signal] - the client request's signal
 * @param {number} [options.delayMs] - 0 disables
 * @param {number} [options.keepaliveMs] - comment interval while waiting; 0 disables early headers too
 * @param {any} [options.log]
 */
export async function respondWithEarlyHeaders({ run, sourceFormat, signal = null, delayMs = STREAM_EARLY_HEADERS_MS, keepaliveMs = STREAM_KEEPALIVE_MS, log = null }) {
  const abort = new AbortController();
  if (signal?.aborted) abort.abort();
  else signal?.addEventListener?.("abort", () => abort.abort(), { once: true });
  const pending = Promise.resolve().then(() => run(abort.signal));
  // Without keepalives an early stream would sit silent, which proxies cut too.
  if (!(delayMs > 0) || !(keepaliveMs > 0)) return pending;

  let timer = null;
  const early = new Promise((resolve) => { timer = setTimeout(resolve, delayMs, EARLY); });
  let first;
  try {
    first = await Promise.race([pending, early]);
  } finally {
    clearTimeout(timer);
  }
  if (first !== EARLY) return first;

  log?.info?.("STREAM", `no upstream headers after ${delayMs}ms, sent early SSE headers`);
  return new Response(earlyStream({ pending, sourceFormat, abort, keepaliveMs, log }), { headers: SSE_HEADERS_CORS });
}

function earlyStream({ pending, sourceFormat, abort, keepaliveMs, log }) {
  let interval = null;
  let cancelled = false;
  let reader = null;
  let tail = null;
  const stopKeepalive = () => {
    if (interval) { clearInterval(interval); interval = null; }
  };

  const settled = pending.then(async (response) => {
    stopKeepalive();
    if (cancelled) {
      response?.body?.cancel().catch(() => {});
      return;
    }
    if (isEventStream(response)) {
      reader = response.body.getReader();
      return;
    }
    tail = await terminalBytes(response, sourceFormat);
  }, (error) => {
    stopKeepalive();
    // Not an upstream failure: keep the detail in the log, as the plain 500 did.
    log?.error?.("STREAM", `request failed after early headers: ${error?.stack || error?.message || error}`);
    tail = buildEarlyErrorBytes(HTTP_STATUS.SERVER_ERROR, DEFAULT_ERROR_MESSAGES[HTTP_STATUS.SERVER_ERROR], sourceFormat);
  });

  return new ReadableStream({
    start(controller) {
      // Some bytes now, so the headers are flushed rather than held for the first write.
      controller.enqueue(KEEPALIVE_BYTES);
      interval = setInterval(() => {
        try { controller.enqueue(KEEPALIVE_BYTES); } catch { stopKeepalive(); }
      }, keepaliveMs);
    },
    async pull(controller) {
      await settled;
      if (cancelled) return;
      if (!reader) {
        if (tail) controller.enqueue(tail);
        tail = null;
        controller.close();
        return;
      }
      let chunk;
      try {
        chunk = await reader.read();
      } catch (error) {
        // The stream failed without writing its own terminal: end it with one,
        // so the client sees an error rather than a reply that just stops.
        if (cancelled) return;
        log?.warn?.("STREAM", `stream failed after early headers: ${error?.message || error}`);
        try {
          controller.enqueue(buildEarlyErrorBytes(HTTP_STATUS.BAD_GATEWAY, DEFAULT_ERROR_MESSAGES[HTTP_STATUS.BAD_GATEWAY], sourceFormat));
          controller.close();
        } catch { /* already closed */ }
        return;
      }
      if (chunk.done) controller.close();
      else controller.enqueue(chunk.value);
    },
    cancel(reason) {
      cancelled = true;
      stopKeepalive();
      abort.abort();
      reader?.cancel(reason).catch(() => {});
    },
  });
}
