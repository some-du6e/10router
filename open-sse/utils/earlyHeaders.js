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
import { CLAUDE_STREAM_ERROR_TYPES, RESPONSES_STREAM_ERROR_CODES } from "../config/errorConfig.js";
import { buildStreamErrorBytes, formatSSE } from "./streamHelpers.js";
import { SSE_HEADERS_CORS, SSE_KEEPALIVE } from "./sseConstants.js";
import { jsonReplyToSse } from "../handlers/chatCore/jsonToSse.js";

const encoder = new TextEncoder();
const KEEPALIVE_BYTES = encoder.encode(SSE_KEEPALIVE);
const EARLY = Symbol("early");
const MAX_MESSAGE = 2000;

/** Would the client have retried this failure if it had come as an HTTP status? */
export function isRetryableFailure(status, headers = null) {
  if (headers?.get?.("x-should-retry") === "false") return false;
  return status === HTTP_STATUS.REQUEST_TIMEOUT || status === HTTP_STATUS.RATE_LIMITED || status >= HTTP_STATUS.SERVER_ERROR;
}

/**
 * The final error of a stream whose headers already went out, in the client's
 * own format: Claude `event: error`, Responses `response.failed`, OpenAI
 * `data: {"error":…}` + [DONE].
 */
export function buildEarlyErrorBytes(status, message, sourceFormat, { retryable = isRetryableFailure(status), exhausted = false } = {}) {
  if (sourceFormat === FORMATS.CLAUDE) {
    const type = retryable
      ? CLAUDE_STREAM_ERROR_TYPES.retryable
      : CLAUDE_STREAM_ERROR_TYPES[status] || CLAUDE_STREAM_ERROR_TYPES.default;
    return encoder.encode(formatSSE({ type: "error", error: { type, message } }, FORMATS.CLAUDE));
  }
  if (sourceFormat === FORMATS.OPENAI_RESPONSES) {
    const codes = RESPONSES_STREAM_ERROR_CODES;
    const code = retryable
      ? (status === HTTP_STATUS.RATE_LIMITED ? codes.rateLimited : codes.retryable)
      : (exhausted ? codes.quota : codes.final);
    return encoder.encode(formatSSE({
      event: "response.failed",
      data: {
        type: "response.failed",
        sequence_number: 0,
        response: { id: `resp_${Date.now()}`, object: "response", status: "failed", error: { code, message } },
      },
    }, FORMATS.OPENAI_RESPONSES));
  }
  return buildStreamErrorBytes(status, message, FORMATS.OPENAI);
}

async function failureMessage(response) {
  const text = await response.text().catch(() => "");
  let message = text;
  try {
    const json = JSON.parse(text);
    const err = json?.error;
    message = (typeof err?.message === "string" && err.message) || (typeof err === "string" && err) || json?.message || text;
  } catch { /* plain-text body */ }
  return String(message || `request failed (${response.status})`).slice(0, MAX_MESSAGE);
}

// Bytes that end a committed stream for a routing result that isn't a stream.
async function terminalBytes(response, sourceFormat) {
  if (response.ok) {
    const replay = jsonReplyToSse(await response.json().catch(() => null), sourceFormat);
    if (replay) return encoder.encode(replay);
    return buildEarlyErrorBytes(HTTP_STATUS.BAD_GATEWAY, "upstream reply was not a stream", sourceFormat);
  }
  const retryable = isRetryableFailure(response.status, response.headers);
  return buildEarlyErrorBytes(response.status, await failureMessage(response), sourceFormat, {
    retryable,
    exhausted: !retryable && response.headers.get("x-should-retry") === "false",
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
 * failure. A client that hangs up aborts `signal`.
 *
 * @param {object} options
 * @param {(signal: AbortSignal) => Promise<Response>} options.run
 * @param {string} options.sourceFormat - client's wire format
 * @param {number} [options.delayMs] - 0 disables
 * @param {number} [options.keepaliveMs] - comment interval while waiting
 * @param {any} [options.log]
 */
export async function respondWithEarlyHeaders({ run, sourceFormat, delayMs = STREAM_EARLY_HEADERS_MS, keepaliveMs = STREAM_KEEPALIVE_MS, log = null }) {
  const abort = new AbortController();
  const pending = Promise.resolve().then(() => run(abort.signal));
  if (!(delayMs > 0)) return pending;

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
  return new Response(earlyStream({ pending, sourceFormat, abort, intervalMs: keepaliveMs > 0 ? keepaliveMs : delayMs, log }), { headers: SSE_HEADERS_CORS });
}

function earlyStream({ pending, sourceFormat, abort, intervalMs, log }) {
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
    log?.warn?.("STREAM", `request failed after early headers: ${error?.message || error}`);
    tail = buildEarlyErrorBytes(HTTP_STATUS.SERVER_ERROR, String(error?.message || "request failed").slice(0, MAX_MESSAGE), sourceFormat);
  });

  return new ReadableStream({
    start(controller) {
      // Some bytes now, so the headers are flushed rather than held for the first write.
      controller.enqueue(KEEPALIVE_BYTES);
      interval = setInterval(() => {
        try { controller.enqueue(KEEPALIVE_BYTES); } catch { stopKeepalive(); }
      }, intervalMs);
    },
    async pull(controller) {
      await settled;
      if (cancelled) return;
      try {
        if (!reader) {
          if (tail) controller.enqueue(tail);
          tail = null;
          controller.close();
          return;
        }
        const { done, value } = await reader.read();
        if (done) controller.close();
        else controller.enqueue(value);
      } catch {
        try { controller.close(); } catch { /* already closed */ }
      }
    },
    cancel(reason) {
      cancelled = true;
      stopKeepalive();
      abort.abort();
      reader?.cancel(reason).catch(() => {});
    },
  });
}
