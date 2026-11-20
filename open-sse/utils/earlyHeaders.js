// Early headers: answer a client before the upstream does.
//
// A proxy in front of 10router (Cloudflare: 524 after ~100-120s) drops a request
// that gets no response headers in time. Account and combo fallback run before
// any headers go out, so one slow upstream, or several in a row, can keep the
// client waiting past that. After `delayMs` this sends 200 and keepalive bytes
// while routing carries on server-side, then the real reply, or the final
// failure in the client's own format. A streaming client gets SSE headers and
// comment keepalives; a JSON client gets a JSON content type and whitespace,
// which every JSON parser skips before the body.
import { FORMATS } from "../translator/formats.js";
import { HTTP_STATUS, STREAM_EARLY_HEADERS_MS, STREAM_KEEPALIVE_MS } from "../config/runtimeConfig.js";
import {
  CLAUDE_RETRYABLE_STREAM_ERROR_TYPE, RESPONSES_STREAM_ERROR_CODES,
  SHOULD_RETRY_HEADER, SHOULD_RETRY_NO, DEFAULT_ERROR_MESSAGES,
} from "../config/errorConfig.js";
import { buildStreamErrorBytes, formatSSE } from "./streamHelpers.js";
import { buildErrorBody, parseUpstreamError } from "./error.js";
import { formatIncompleteOpenAIResponsesStreamFailure } from "./responsesStreamHelpers.js";
import { SSE_HEADERS_CORS, SSE_KEEPALIVE, JSON_HEADERS_CORS, JSON_KEEPALIVE } from "./sseConstants.js";

const encoder = new TextEncoder();
const EARLY = Symbol("early");
const MAX_MESSAGE = 2000;

// Should the in-band error ask the client to retry? 408, 409, 429 and 5xx are
// what the Anthropic and OpenAI SDKs (and so Claude Code) retry as HTTP statuses.
// Codex over HTTP (codex-rs api_bridge.rs; protocol/src/error.rs retry_delay)
// retries 408, 409, 5xx and any other status but 400 at the turn level; a 429
// becomes RetryLimit, retried only when the response carried Retry-After (0.166;
// 0.137 has no retry_delay and never retries an HTTP 429). In-band
// a 429 is rate_limit_exceeded, which Codex always retries (with backoff if no
// delay is given), and 401/403/404 are final where HTTP would have retried them.
function isRetryableFailure(status, headers = null) {
  if (headers?.get?.(SHOULD_RETRY_HEADER) === SHOULD_RETRY_NO) return false;
  return [HTTP_STATUS.REQUEST_TIMEOUT, HTTP_STATUS.CONFLICT, HTTP_STATUS.RATE_LIMITED].includes(status) || status >= HTTP_STATUS.SERVER_ERROR;
}

function responsesErrorCode(status, retryable) {
  const codes = RESPONSES_STREAM_ERROR_CODES;
  if (!retryable) return codes.final;
  return status === HTTP_STATUS.RATE_LIMITED ? codes.rateLimited : codes.retryable;
}

/**
 * The final error of a stream whose headers already went out, in the client's
 * own format: Claude `event: error`, Responses `response.failed`, OpenAI
 * `data: {"error":…}` + [DONE]. A Responses stream nothing has opened yet
 * (`opened` false) gets a `response.created` first, as the real API sends.
 */
export function buildEarlyErrorBytes(status, message, sourceFormat, { retryable = isRetryableFailure(status), opened = false } = {}) {
  if (sourceFormat === FORMATS.CLAUDE) {
    return buildStreamErrorBytes(status, message, FORMATS.CLAUDE, retryable ? { type: CLAUDE_RETRYABLE_STREAM_ERROR_TYPE } : {});
  }
  if (sourceFormat === FORMATS.OPENAI_RESPONSES) {
    const code = responsesErrorCode(status, retryable);
    const id = `resp_${Date.now()}`;
    const created = opened ? "" : formatSSE({
      event: "response.created",
      data: { type: "response.created", response: { id, object: "response", created_at: Math.floor(Date.now() / 1000), status: "in_progress", output: [] } },
    }, FORMATS.OPENAI_RESPONSES);
    return encoder.encode(created + formatIncompleteOpenAIResponsesStreamFailure({ id, code, message }));
  }
  return buildStreamErrorBytes(status, message, FORMATS.OPENAI);
}

/**
 * The body of a JSON reply whose 200 already went out, when the request failed:
 * the error body the client's own API sends (Claude `{"type":"error","error":…}`,
 * OpenAI `{"error":…}`). A Responses client gets a `status: "failed"` Response
 * object, as the API returns for a failed response it reports with a 200, whose
 * `error` carries the same message, type and code.
 */
export function buildEarlyJsonErrorBytes(status, message, sourceFormat, { retryable = isRetryableFailure(status) } = {}) {
  const { error } = buildErrorBody(status, message);
  let body = { error };
  if (sourceFormat === FORMATS.CLAUDE) {
    if (retryable) error.type = CLAUDE_RETRYABLE_STREAM_ERROR_TYPE;
    body = { type: "error", error };
  } else if (sourceFormat === FORMATS.OPENAI_RESPONSES) {
    error.code = responsesErrorCode(status, retryable);
    body = { id: `resp_${Date.now()}`, object: "response", created_at: Math.floor(Date.now() / 1000), status: "failed", output: [], error };
  }
  return encoder.encode(JSON.stringify(body));
}

const isEventStreamType = (response) =>
  (response.headers.get("content-type") || "").toLowerCase().includes("text/event-stream");

// What an early reply looks like on the wire. `isBody` is the routed reply the
// client can be given as is; anything else ok is `notBody`. `appendAfterBody`:
// can a failure while piping still be told in-band (SSE can add an event; a
// half-written JSON body can't be finished, so the connection is cut instead).
const WIRES = {
  sse: {
    headers: SSE_HEADERS_CORS,
    keepalive: encoder.encode(SSE_KEEPALIVE),
    isBody: (response) => response.ok && !!response.body && isEventStreamType(response),
    // A JSON success can't land here: chatCore already replays one as the
    // client's stream, so an ok non-stream reply is one it couldn't replay.
    notBody: "upstream reply was not a stream",
    errorBytes: buildEarlyErrorBytes,
    appendAfterBody: true,
  },
  json: {
    headers: JSON_HEADERS_CORS,
    keepalive: encoder.encode(JSON_KEEPALIVE),
    isBody: (response) => response.ok && !!response.body && !isEventStreamType(response),
    notBody: "upstream reply was not JSON",
    errorBytes: buildEarlyJsonErrorBytes,
    appendAfterBody: false,
  },
};

// Bytes that end a committed reply for a routing result that isn't its body.
async function terminalBytes(response, sourceFormat, wire) {
  if (response.ok) {
    response.body?.cancel().catch(() => {});
    return wire.errorBytes(HTTP_STATUS.BAD_GATEWAY, wire.notBody, sourceFormat);
  }
  return wire.errorBytes(response.status, (await parseUpstreamError(response)).message.slice(0, MAX_MESSAGE), sourceFormat, {
    retryable: isRetryableFailure(response.status, response.headers),
  });
}

/**
 * Run `run(signal)`. If it answers within `delayMs` its Response is returned
 * as is, real status included. Otherwise a 200 Response is returned at
 * `delayMs`, carrying keepalives until `run` settles and then its body or
 * failure. `signal` aborts when the client hangs up, before or after the
 * headers went out.
 *
 * @param {object} options
 * @param {(signal: AbortSignal) => Promise<Response>} options.run
 * @param {string} options.sourceFormat - client's wire format
 * @param {boolean} [options.json] - the client reads one JSON body, not a stream
 * @param {AbortSignal|null} [options.signal] - the client request's signal
 * @param {number} [options.delayMs] - 0 disables
 * @param {number} [options.keepaliveMs] - keepalive interval while waiting; 0 disables early headers too
 * @param {any} [options.log]
 */
export async function respondWithEarlyHeaders({ run, sourceFormat, json = false, signal = null, delayMs = STREAM_EARLY_HEADERS_MS, keepaliveMs = STREAM_KEEPALIVE_MS, log = null }) {
  const abort = new AbortController();
  if (signal?.aborted) abort.abort();
  else signal?.addEventListener?.("abort", () => abort.abort(), { once: true });
  const pending = Promise.resolve().then(() => run(abort.signal));
  // Without keepalives an early reply would sit silent, which proxies cut too.
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

  const wire = json ? WIRES.json : WIRES.sse;
  log?.info?.("STREAM", `no upstream reply after ${delayMs}ms, sent early ${json ? "JSON" : "SSE"} headers`);
  return new Response(earlyBody({ pending, sourceFormat, wire, abort, keepaliveMs, log }), { headers: wire.headers });
}

function earlyBody({ pending, sourceFormat, wire, abort, keepaliveMs, log }) {
  let interval = null;
  let cancelled = false;
  let reader = null;
  let piped = false;
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
    if (wire.isBody(response)) {
      reader = response.body.getReader();
      return;
    }
    tail = await terminalBytes(response, sourceFormat, wire);
  }, (error) => {
    stopKeepalive();
    // Not an upstream failure: keep the detail in the log, as the plain 500 did.
    log?.error?.("STREAM", `request failed after early headers: ${error?.stack || error?.message || error}`);
    tail = wire.errorBytes(HTTP_STATUS.SERVER_ERROR, DEFAULT_ERROR_MESSAGES[HTTP_STATUS.SERVER_ERROR], sourceFormat);
  });

  return new ReadableStream({
    start(controller) {
      // Some bytes now, so the headers are flushed rather than held for the first write.
      controller.enqueue(wire.keepalive);
      interval = setInterval(() => {
        try { controller.enqueue(wire.keepalive); } catch { stopKeepalive(); }
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
        // The reply failed without writing its own end: end it with an error,
        // so the client sees one rather than a reply that just stops.
        if (cancelled) return;
        log?.warn?.("STREAM", `reply failed after early headers: ${error?.message || error}`);
        try {
          if (piped && !wire.appendAfterBody) { controller.error(error); return; }
          controller.enqueue(wire.errorBytes(HTTP_STATUS.BAD_GATEWAY, DEFAULT_ERROR_MESSAGES[HTTP_STATUS.BAD_GATEWAY], sourceFormat, { opened: piped }));
          controller.close();
        } catch { /* already closed */ }
        return;
      }
      if (chunk.done) controller.close();
      else { piped = true; controller.enqueue(chunk.value); }
    },
    cancel(reason) {
      cancelled = true;
      stopKeepalive();
      abort.abort();
      reader?.cancel(reason).catch(() => {});
    },
  });
}
