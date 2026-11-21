// Memory admission for the chat routes.
//
// A request in flight holds its prompt several times over (the parsed body, the
// translated body, the string sent upstream) until its reply starts streaming (a
// non-streamed one: until it ends). Coding agents send prompts of several MB,
// and after a restart they all retry at once, so enough of them together take
// the process past its memory limit, it is killed, and every request in flight
// fails with it. This gate counts the body bytes the
// admitted requests hold and lets a new one in only while it fits a budget and
// the process's resident memory is under a high-water mark. Otherwise the
// request waits its turn (FIFO) for a while, then gets a 503 with Retry-After,
// which the agents' SDKs retry. With nothing in flight a request is always let
// in, however big, so one huge prompt is never starved. Limits are in
// MEMORY_ADMISSION (open-sse/config/runtimeConfig.js).
import { readCgroupMemoryLimit } from "@/shared/utils/cgroupMemory.js";
import { HTTP_STATUS, MEMORY_ADMISSION } from "open-sse/config/runtimeConfig.js";
import { CLAUDE_RETRYABLE_STREAM_ERROR_TYPE } from "open-sse/config/errorConfig.js";
import { FORMATS, detectFormatByEndpoint } from "open-sse/translator/formats.js";
import { buildErrorBody, clientAbortResult } from "open-sse/utils/error.js";
import * as log from "../utils/logger.js";

const MB = 1024 * 1024;
const TAG = "MEMORY";
const mb = (bytes) => `${Math.round(bytes / MB)}MB`;

// Shared with request details, which size their buffers to the same limit.
export { readCgroupMemoryLimit };

/**
 * The resident-memory high-water mark in bytes, or 0 for none: MEMORY_HIGH_WATER_MB
 * when set, else a fraction of the container's memory limit.
 */
export function resolveHighWater({ highWaterMb = MEMORY_ADMISSION.highWaterMb, fraction = MEMORY_ADMISSION.highWaterFraction, limit = readCgroupMemoryLimit } = {}) {
  if (highWaterMb >= 0) return highWaterMb * MB;
  const bytes = limit();
  return bytes ? Math.floor(bytes * fraction) : 0;
}

/**
 * @typedef {object} AdmissionTicket
 * @property {number} bytes - bytes this request is counted as holding
 * @property {(bodyLength: number) => void} noteBodyLength - the body was read: count it at least this long
 * @property {() => void} release - the request is done; idempotent
 */

/**
 * A gate. Exported for tests; the routes use the shared one (memoryGate()).
 * @param {object} options
 * @param {number} options.budgetBytes - 0: no byte budget
 * @param {number} options.highWaterBytes - 0: no resident-memory check
 * @param {number} [options.bodyCopies]
 * @param {number} [options.maxWaitMs]
 * @param {number} [options.retryAfterSec]
 * @param {number} [options.recheckMs]
 * @param {() => number} [options.rss]
 * @param {any} [options.logger]
 */
export function createMemoryGate({
  budgetBytes,
  highWaterBytes,
  bodyCopies = MEMORY_ADMISSION.bodyCopies,
  maxWaitMs = MEMORY_ADMISSION.maxWaitMs,
  retryAfterSec = MEMORY_ADMISSION.retryAfterSec,
  recheckMs = MEMORY_ADMISSION.recheckMs,
  rss = () => process.memoryUsage.rss(),
  logger = log,
}) {
  const enabled = budgetBytes > 0 || highWaterBytes > 0;
  const weigh = (bodyLength) => Math.max(0, Number(bodyLength) || 0) * bodyCopies;
  let heldBytes = 0;
  let inflight = 0;
  /** @type {{ bytes: number, admit: () => void }[]} */
  const queue = [];
  let recheck = null;
  // Set from the first refusal until the next admission, so each episode logs twice.
  let refusingSince = 0;
  let refusedInEpisode = 0;
  const totals = { admitted: 0, queued: 0, refused: 0, aborted: 0 };

  // Why a request of `bytes` can't go in now, or null. Nothing in flight: it
  // goes in, so an oversized prompt isn't starved and a resident size that
  // hasn't come down since the last requests ended can't wedge the gate.
  function blocker(bytes) {
    if (inflight === 0) return null;
    if (budgetBytes > 0 && heldBytes + bytes > budgetBytes) return "budget";
    if (highWaterBytes > 0 && rss() > highWaterBytes) return "memory";
    return null;
  }

  function describe() {
    const parts = [`${inflight} in flight holding ${mb(heldBytes)}`];
    if (budgetBytes > 0) parts[0] += ` of ${mb(budgetBytes)}`;
    if (highWaterBytes > 0) parts.push(`rss ${mb(rss())} (high water ${mb(highWaterBytes)})`);
    parts.push(`${queue.length} waiting`);
    return parts.join(", ");
  }

  /** @returns {AdmissionTicket} */
  function grant(bytes) {
    heldBytes += bytes;
    inflight++;
    totals.admitted++;
    if (refusingSince) {
      logger?.info?.(TAG, `admitting requests again after refusing ${refusedInEpisode} over ${Math.round((Date.now() - refusingSince) / 1000)}s (${describe()})`);
      refusingSince = 0;
      refusedInEpisode = 0;
    }
    let held = bytes;
    let released = false;
    return {
      get bytes() { return held; },
      noteBodyLength(bodyLength) {
        const next = weigh(bodyLength);
        if (released || next <= held) return;
        heldBytes += next - held;
        held = next;
      },
      release() {
        if (released) return;
        released = true;
        heldBytes -= held;
        inflight--;
        pump();
      },
    };
  }

  function refuse(reason) {
    totals.refused++;
    refusedInEpisode++;
    if (!refusingSince) {
      refusingSince = Date.now();
      logger?.warn?.(TAG, `refusing new requests (${reason}): ${describe()}`);
    }
    return { refused: reason, retryAfterSec };
  }

  // Let in waiting requests from the front while they fit.
  function pump() {
    while (queue.length > 0 && !blocker(queue[0].bytes)) queue.shift().admit();
    if (queue.length === 0 && recheck) {
      clearInterval(recheck);
      recheck = null;
    }
  }

  /**
   * Wait for room for a request whose body is `bodyLength` bytes.
   * @param {{ bodyLength?: number, signal?: AbortSignal | null }} [options]
   * @returns {Promise<{ ticket: AdmissionTicket } | { refused: string, retryAfterSec: number } | { aborted: true }>}
   */
  async function acquire({ bodyLength = 0, signal = null } = {}) {
    const bytes = weigh(bodyLength);
    if (signal?.aborted) return { aborted: true };
    // Behind anyone already waiting: the queue is first come, first served.
    if (queue.length === 0 && !blocker(bytes)) return { ticket: grant(bytes) };
    if (!(maxWaitMs > 0)) return refuse(blocker(bytes) || "queue");

    totals.queued++;
    return new Promise((resolve) => {
      let timer = null;
      const waiter = { bytes, admit: () => settle({ ticket: grant(bytes) }) };
      const onAbort = () => {
        totals.aborted++;
        settle({ aborted: true });
      };
      function settle(result) {
        clearTimeout(timer);
        signal?.removeEventListener?.("abort", onAbort);
        const at = queue.indexOf(waiter);
        if (at >= 0) queue.splice(at, 1);
        resolve(result);
        // Leaving from the front may let the next one in.
        if (at === 0) pump();
      }
      timer = setTimeout(() => {
        // Out of turn but it fits now: let it in rather than turn it away.
        const why = blocker(bytes);
        settle(why ? refuse(why) : { ticket: grant(bytes) });
      }, maxWaitMs);
      signal?.addEventListener?.("abort", onAbort, { once: true });
      queue.push(waiter);
      // Resident memory drops on garbage collection, with no request ending.
      if (highWaterBytes > 0 && !recheck) {
        recheck = setInterval(pump, recheckMs);
        recheck.unref?.();
      }
    });
  }

  return {
    enabled,
    acquire,
    retryAfterSec,
    stats: () => ({
      enabled, inflight, heldBytes, waiting: queue.length, budgetBytes, highWaterBytes,
      refusing: refusingSince > 0, ...totals,
    }),
  };
}

let shared = null;

/** The process's gate, built from MEMORY_ADMISSION on first use. */
export function memoryGate() {
  shared ??= createMemoryGate({ budgetBytes: MEMORY_ADMISSION.budgetBytes, highWaterBytes: resolveHighWater() });
  return shared;
}

/** Counters for a status endpoint. */
export function memoryAdmissionStats() {
  return memoryGate().stats();
}

// Request → its ticket, so a route that reads or rewrites the body before
// handing a new Request to handleChat admits once, before its own copy.
const tickets = new WeakMap();

/** `to` was built from `from`: it runs under `from`'s admission. Returns `to`. */
export function carryAdmission(from, to) {
  const ticket = tickets.get(from);
  if (ticket && to && to !== from) tickets.set(to, ticket);
  return to;
}

function contentLength(request) {
  const n = Number(request.headers?.get?.("content-length"));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// The client's wire format, from the path alone: the body isn't read yet.
function formatOf(request) {
  let pathname = "";
  try { pathname = new URL(request.url).pathname; } catch { /* no URL */ }
  return detectFormatByEndpoint(pathname, null)
    || (/\/responses(\/|$)/.test(pathname) ? FORMATS.OPENAI_RESPONSES : FORMATS.OPENAI);
}

/**
 * The refusal, as the client's own API words an overload: Claude
 * `{"type":"error","error":{"type":"overloaded_error"}}`, OpenAI and Responses
 * `{"error":{"type":"server_error","code":"service_unavailable"}}`. 503 with
 * Retry-After, which the Anthropic and OpenAI SDKs and Codex retry.
 */
export function busyResponse(format, retryAfterSec) {
  const status = HTTP_STATUS.SERVICE_UNAVAILABLE;
  const message = `Server is busy with other large requests; retry in ${retryAfterSec}s.`;
  const { error } = buildErrorBody(status, message);
  const body = format === FORMATS.CLAUDE
    ? { type: "error", error: { type: CLAUDE_RETRYABLE_STREAM_ERROR_TYPE, message } }
    : { error };
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Retry-After": String(retryAfterSec),
    },
  });
}

/**
 * Hand back `response` with the ticket released when its body ends, fails or is
 * cancelled, or when the client hangs up, whichever comes first.
 * @param {Response} response
 * @param {AdmissionTicket} ticket
 * @param {AbortSignal | null} [signal]
 */
export function releaseWhenDone(response, ticket, signal = null) {
  const onAbort = () => done();
  function done() {
    signal?.removeEventListener?.("abort", onAbort);
    ticket.release();
  }
  if (!response?.body || signal?.aborted) {
    done();
    return response;
  }
  signal?.addEventListener?.("abort", onAbort, { once: true });
  const reader = response.body.getReader();
  const body = new ReadableStream({
    async pull(controller) {
      let chunk;
      try {
        chunk = await reader.read();
      } catch (error) {
        done();
        controller.error(error);
        return;
      }
      if (chunk.done) {
        done();
        controller.close();
      } else {
        controller.enqueue(chunk.value);
      }
    },
    cancel(reason) {
      done();
      return reader.cancel(reason);
    },
  }, { highWaterMark: 0 });
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

/**
 * Run `run(ticket)` once the gate admits `request`, and release the admission
 * when its reply is over. A request the gate turns away gets busyResponse; one
 * whose client hangs up while waiting gets the usual 499. A request an outer
 * route already admitted (carryAdmission) runs at once under that admission.
 * @param {Request} request
 * @param {(ticket: AdmissionTicket | null) => Promise<Response>} run
 * @param {{ gate?: ReturnType<typeof createMemoryGate> }} [options]
 * @returns {Promise<Response>}
 */
export async function withMemoryAdmission(request, run, { gate = memoryGate() } = {}) {
  const outer = tickets.get(request);
  if (outer) return run(outer);
  if (!gate.enabled) return run(null);

  const result = await gate.acquire({ bodyLength: contentLength(request), signal: request.signal });
  if ("aborted" in result) return clientAbortResult().response;
  if (!("ticket" in result)) return busyResponse(formatOf(request), result.retryAfterSec);

  const { ticket } = result;
  tickets.set(request, ticket);
  let response;
  try {
    response = await run(ticket);
  } catch (error) {
    ticket.release();
    throw error;
  }
  return releaseWhenDone(response, ticket, request.signal);
}
