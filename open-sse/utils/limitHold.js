// Rate-limit hold: keep a client's stream alive across a provider limit.
//
// Normally a provider limit ends the request with an error. When hold is enabled
// we instead write a visible status line into the assistant turn, keep the socket
// warm, wait for the limit to reset, retry, and splice the real answer in behind
// the banner — so the client sees one continuous response that simply took a while.
import { translateResponse, initState } from "../translator/index.js";
import { FORMATS } from "../translator/formats.js";
import { ROLE, OPENAI_FINISH } from "../translator/schema/index.js";
import { formatSSE } from "./stream.js";

// Present in every banner we emit. Later requests carry the banner back inside
// their history; detecting this marker is what triggers the "ignore that line"
// system turn. Keep it stable — changing it orphans banners already in transcripts.
export const LIMIT_HOLD_SENTINEL = "[10router:limit-hold]";

// Defaults; overridable via the `timing` option so tests don't have to sit
// through a real cooldown.
export const DEFAULT_TIMING = {
  keepaliveMs: 15_000,
  // Providers routinely under-report resets; never hammer, never trust a long
  // second estimate either — after the first wake we re-check on a fixed beat.
  minWaitMs: 30_000,
  recheckMs: 5 * 60 * 1000,
  // Ceiling for the non-streaming hold only. A streaming client can be left
  // waiting indefinitely because its socket is the liveness signal — hang up and
  // the hold ends. A non-streaming request has no such signal, so an upstream
  // that reports a limit forever would pin a connection and handler with nothing
  // to release them.
  maxHoldMs: 6 * 60 * 60 * 1000,
};

/**
 * Does this failure mean "come back later" rather than "this is broken"?
 * Auth failures, 5xx and network errors are handled by the existing retry and
 * account-fallback paths — holding on them would just hide a real fault.
 */
export function isLimitError(status, errorText = "") {
  if (status === 429) return true;
  const text = typeof errorText === "string" ? errorText.toLowerCase() : "";
  return (
    text.includes("usage_limit_reached") ||
    text.includes("rate limit") ||
    text.includes("rate_limit") ||
    text.includes("quota") ||
    text.includes("premium request") ||
    text.includes("resource_exhausted")
  );
}

/** "2h 14m" / "45s" — approximate on purpose, this is a status line not a contract. */
export function formatDuration(ms) {
  const total = Math.max(Math.round(ms / 1000), 0);
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  if (hours < 24) return remMinutes ? `${hours}h ${remMinutes}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours ? `${days}d ${remHours}h` : `${days}d`;
}

export function buildBannerText({ provider, waitMs, attempt }) {
  const when = waitMs > 0 ? `retrying in ${formatDuration(waitMs)}` : "retrying now";
  const nth = attempt > 1 ? ` · attempt ${attempt}` : "";
  return `\n──── ⏳ ${provider} limit reached — ${when}${nth} · ${LIMIT_HOLD_SENTINEL} ────\n`;
}

/**
 * Render assistant text as SSE in the client's own format.
 *
 * Every chunk is produced by the real translator (OpenAI chunk → sourceFormat),
 * so the banner is structurally identical to model output rather than a
 * hand-rolled guess at each format's framing.
 */
function renderTextChunks(sourceFormat, model, text, state) {
  const chunk = {
    id: state._holdId,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta: { role: ROLE.ASSISTANT, content: text }, finish_reason: null }],
  };
  const translated = translateResponse(FORMATS.OPENAI, sourceFormat, chunk, state) || [];
  return translated.map((item) => formatSSE(item, sourceFormat));
}

/**
 * Run a finish chunk through the translator to close what the banner opened.
 *
 * `terminate: false` keeps the message envelope open so the real upstream stream
 * can continue it — the translator's own flush emits nothing, so without this the
 * banner's content block would still be open when the real stream's block starts.
 */
function renderFinishChunks(sourceFormat, model, state, { terminate }) {
  const chunk = {
    id: state._holdId,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta: {}, finish_reason: OPENAI_FINISH.STOP }],
  };
  let translated = translateResponse(FORMATS.OPENAI, sourceFormat, chunk, state) || [];
  if (!terminate) {
    // Drop the events that would end the message rather than just the block.
    const enders = new Set(["message_delta", "message_stop", "response.completed", "response.incomplete"]);
    translated = translated.filter((item) => !enders.has(item?.type || item?.data?.type));
  }
  return translated.map((item) => formatSSE(item, sourceFormat));
}

/**
 * Rewrite the real upstream stream so it can follow banner content in one message.
 *
 * OpenAI-shaped formats treat chunks as independent, so they pass through
 * untouched. Claude and the Responses API carry an explicit message envelope and
 * indexed content blocks — a second `message_start` or a re-used block index
 * would corrupt the client's parse, so those get their opening events dropped and
 * their indices shifted past the block the banner already occupies.
 */
function needsEnvelopeRewrite(sourceFormat) {
  return sourceFormat === FORMATS.CLAUDE || sourceFormat === FORMATS.OPENAI_RESPONSES;
}

function createSpliceTransform(sourceFormat, blockOffset) {
  if (!needsEnvelopeRewrite(sourceFormat) || blockOffset <= 0) return null;

  let buffer = "";
  let sequence = 0;
  // One codec pair per stream: `{ stream: true }` only carries partial-sequence
  // state within a single decoder, so a fresh one per chunk mangles any
  // multi-byte character that straddles a chunk boundary.
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  const rewriteEvent = (raw) => {
    const dataMatch = raw.match(/^data: (.*)$/m);
    if (!dataMatch) return raw;
    let payload;
    try {
      payload = JSON.parse(dataMatch[1]);
    } catch {
      return raw; // [DONE] and other non-JSON lines pass straight through
    }

    if (sourceFormat === FORMATS.CLAUDE) {
      // The banner already opened the message and closed block 0.
      if (payload.type === "message_start") return "";
      if (typeof payload.index === "number") payload.index += blockOffset;
      return formatSSE(payload, sourceFormat);
    }

    // openai-responses: one envelope per response, output items are indexed.
    if (payload.type === "response.created" || payload.type === "response.in_progress") return "";
    if (typeof payload.output_index === "number") payload.output_index += blockOffset;
    if (typeof payload.sequence_number === "number") payload.sequence_number = sequence++;
    const eventMatch = raw.match(/^event: (.*)$/m);
    return eventMatch ? `event: ${eventMatch[1]}\ndata: ${JSON.stringify(payload)}\n\n` : formatSSE(payload, sourceFormat);
  };

  return new TransformStream({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      // SSE events are blank-line delimited; keep any partial tail for next time.
      const parts = buffer.split("\n\n");
      buffer = parts.pop() ?? "";
      const out = parts.map((p) => rewriteEvent(`${p}\n\n`)).join("");
      if (out) controller.enqueue(encoder.encode(out));
    },
    flush(controller) {
      if (buffer.trim()) {
        const out = rewriteEvent(buffer.endsWith("\n\n") ? buffer : `${buffer}\n\n`);
        if (out) controller.enqueue(encoder.encode(out));
      }
    },
  });
}

/**
 * Non-streaming variant: there is no stream to write a banner into, so the
 * request simply hangs until the limit clears and the real JSON is returned.
 *
 * @returns {Promise<object|null>} the successful result, or the last failure
 */
export async function awaitLimitClear({ retryAtMs, attempt, provider, model, signal, log, timing }) {
  const { minWaitMs, recheckMs, maxHoldMs } = { ...DEFAULT_TIMING, ...(timing || {}) };
  const deadline = Date.now() + maxHoldMs;
  let waitMs = Math.max((retryAtMs || 0) - Date.now(), minWaitMs);
  let last = null;
  log?.info?.("LIMITHOLD", `${provider}/${model} holding (non-streaming), first retry in ${formatDuration(waitMs)}`);

  while (!signal?.aborted && Date.now() < deadline) {
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, waitMs);
      signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
    });
    if (signal?.aborted) break;

    last = await attempt();
    if (last?.success) return last;
    if (last && !isLimitError(last.status, last.error)) return last;
    waitMs = Math.max((last?.retryAtMs || 0) - Date.now(), recheckMs);
  }
  if (Date.now() >= deadline) {
    log?.warn?.("LIMITHOLD", `${provider}/${model} gave up after ${formatDuration(maxHoldMs)}`);
  }
  return last;
}

/**
 * Hold the client's stream open until the provider limit clears.
 *
 * @param {object} options
 * @param {string} options.sourceFormat - client's wire format
 * @param {string} options.model - model name echoed back to the client
 * @param {string} options.provider - provider name shown in the banner
 * @param {number} options.retryAtMs - epoch ms the provider says the limit resets
 * @param {function} options.attempt - re-runs the request; resolves to the account-loop result
 * @param {object} options.log
 * @returns {Response} streaming response that starts with the banner
 */
export function createLimitHoldResponse({ sourceFormat, model, provider, retryAtMs, attempt, log, timing }) {
  const { keepaliveMs, minWaitMs, recheckMs } = { ...DEFAULT_TIMING, ...(timing || {}) };
  const encoder = new TextEncoder();
  const state = initState(sourceFormat);
  state.model = model;
  state._holdId = `chatcmpl-hold-${Date.now()}`;

  let cancelled = false;
  let wakeTimer = null;
  let keepaliveTimer = null;
  const abortController = new AbortController();

  const stop = () => {
    cancelled = true;
    if (wakeTimer) clearTimeout(wakeTimer);
    if (keepaliveTimer) clearInterval(keepaliveTimer);
    wakeTimer = null;
    keepaliveTimer = null;
    abortController.abort();
  };

  const stream = new ReadableStream({
    async start(controller) {
      const write = (text) => {
        if (cancelled) return;
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          stop();
        }
      };
      const writeBanner = (waitMs, attemptNo) => {
        for (const piece of renderTextChunks(sourceFormat, model, buildBannerText({ provider, waitMs, attempt: attemptNo }), state)) {
          write(piece);
        }
      };
      // A comment line is ignored by every SSE parser but still counts as traffic,
      // which is what stops an intermediate proxy reaping an idle connection.
      keepaliveTimer = setInterval(() => write(`: 10router limit-hold\n\n`), keepaliveMs);

      const sleep = (ms) =>
        new Promise((resolve) => {
          wakeTimer = setTimeout(resolve, ms);
          abortController.signal.addEventListener("abort", () => {
            if (wakeTimer) clearTimeout(wakeTimer);
            resolve();
          }, { once: true });
        });

      let splicedRealStream = false;
      let attemptNo = 1;
      let waitMs = Math.max((retryAtMs || 0) - Date.now(), minWaitMs);
      writeBanner(waitMs, attemptNo);
      log?.info?.("LIMITHOLD", `${provider}/${model} holding stream, first retry in ${formatDuration(waitMs)}`);

      try {
        while (!cancelled) {
          await sleep(waitMs);
          if (cancelled) break;

          attemptNo += 1;
          const result = await attempt();
          if (cancelled) break;

          if (result?.success && result.response?.body) {
            // Close the banner's block — but not the message — so the real
            // stream's blocks can follow it. OpenAI-shaped chunks are
            // independent and need no closing, and emitting a finish_reason
            // there would make some clients stop reading mid-response.
            if (needsEnvelopeRewrite(sourceFormat)) {
              for (const piece of renderFinishChunks(sourceFormat, model, state, { terminate: false })) write(piece);
            }

            const transform = createSpliceTransform(sourceFormat, 1);
            const body = transform ? result.response.body.pipeThrough(transform) : result.response.body;
            const reader = body.getReader();
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              if (cancelled) { await reader.cancel(); break; }
              controller.enqueue(value);
            }
            splicedRealStream = true;
            log?.info?.("LIMITHOLD", `${provider}/${model} resumed after ${attemptNo - 1} retry(s)`);
            break;
          }

          if (result && !isLimitError(result.status, result.error)) {
            // Not a limit any more — a real fault. Say so in the stream rather
            // than waiting forever on something that will never clear.
            for (const piece of renderTextChunks(sourceFormat, model, `\n──── ✗ ${provider} error: ${result.error || "request failed"} · ${LIMIT_HOLD_SENTINEL} ────\n`, state)) {
              write(piece);
            }
            for (const piece of renderFinishChunks(sourceFormat, model, state, { terminate: true })) write(piece);
            break;
          }

          waitMs = Math.max((result?.retryAtMs || 0) - Date.now(), recheckMs);
          writeBanner(waitMs, attemptNo);
        }
      } catch (e) {
        log?.warn?.("LIMITHOLD", `${provider}/${model} hold failed: ${e.message}`);
      } finally {
        stop();
        // The real stream carries its own terminator; only synthesise one when
        // we ended the response ourselves.
        if (!cancelled && !splicedRealStream) write("data: [DONE]\n\n");
        try { controller.close(); } catch { /* already closed by cancel */ }
      }
    },
    cancel() {
      // Client hung up — drop the timers so a dead CLI doesn't leave one ticking.
      log?.info?.("LIMITHOLD", `${provider}/${model} client disconnected, hold released`);
      stop();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
