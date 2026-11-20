// A request error every key would refuse (the prompt is longer than the model's
// context window, the upstream rejects a tool schema) fails the same way on
// each account, so walking all of them only costs time. This tallies one
// request's errors per model and says when enough accounts agreed to stop.
//
// Only errors that read as the request's own fault count
// (SAME_REQUEST_ERROR_PATTERNS, or a 413). An unknown 400 may be about the
// account (a disabled organization, an unverified one) and would never lock
// the key, so stopping on it could fail every request; it keeps the walk.
import { namesAccountOrLimit } from "./accountFallback.js";
import { isLimitError } from "../utils/limitHold.js";
import { HTTP_STATUS, SAME_REQUEST_ERROR_STOP_AFTER, SAME_REQUEST_ERROR_STATUSES } from "../config/runtimeConfig.js";
import {
  MODEL_REFUSAL,
  OPERATION_REFUSAL,
  SAME_REQUEST_ERROR_PATTERNS,
  SAME_REQUEST_ERROR_LIMIT_PATTERNS,
  SAME_REQUEST_ERROR_KEY_LIMIT,
  SAME_REQUEST_ERROR_MAX_TEXT,
} from "../config/errorConfig.js";

// A refusal of one model or operation for this key: about the key, not the request.
const KEY_REFUSAL = new RegExp([MODEL_REFUSAL, OPERATION_REFUSAL].map((r) => r.source).join("|"), "i");

/** The error as text, cut to SAME_REQUEST_ERROR_MAX_TEXT: everything below reads only this much. */
const asText = (error: unknown): string =>
  (error == null ? "" : typeof error === "string" ? error : JSON.stringify(error)).slice(0, SAME_REQUEST_ERROR_MAX_TEXT);

// A relay's per-call id inside the message text: "... (request id: 2026...abc)".
// No leading \s*: that backtracks quadratically on a long run of spaces, and
// normalizeErrorMessage collapses whitespace anyway.
const REQUEST_ID_SUFFIX = / ?\(request id: [^)]{0,128}\)/gi;

/**
 * The upstream's message: chatCore's "[400]: " prefix dropped, and from a JSON
 * body its error.message, else message, else error (the order parseUpstreamError
 * reads them in), so per-call fields such as a request id don't take part. A
 * "(request id: ...)" a relay writes into the message is dropped too.
 */
export function upstreamMessage(error: unknown): string {
  return bodyMessage(error).replace(REQUEST_ID_SUFFIX, "");
}

function bodyMessage(error: unknown): string {
  const text = asText(error).replace(/^\[\d+\]:\s*/, "");
  let json: { error?: { message?: unknown } | unknown; message?: unknown } | null = null;
  try { json = JSON.parse(text); } catch { return text; }
  if (!json || typeof json !== "object") return text;
  const message = (json.error as { message?: unknown } | undefined)?.message || json.message || json.error;
  return message ? asText(message) : text;
}

/**
 * The message in a form two keys' copies of one error share: lowercased, every
 * run of digits as "#" (token counts and sizes differ per call), whitespace collapsed.
 */
export function normalizeErrorMessage(error: unknown): string {
  return upstreamMessage(error).toLowerCase().replace(/\d+/g, "#").replace(/\s+/g, " ").trim();
}

// Text about the key: a bad key, billing, a rate limit or quota, a limit on the
// key, account or plan, or a refusal of one model or operation.
const namesTheKey = (status: number, text: string): boolean =>
  namesAccountOrLimit(text) || isLimitError(status, text) || KEY_REFUSAL.test(text) || SAME_REQUEST_ERROR_KEY_LIMIT.test(text);

/**
 * What identifies this failure as a request error for counting, or null when it
 * doesn't count: another status, a message that doesn't read as the request's
 * fault, or one (in the message or anywhere in the body) about the key. A 413
 * counts whatever its message says, unless that is about the key.
 */
export function requestErrorSignature(status: number | null | undefined, error: unknown): string | null {
  return requestErrorSignatures(status, error)?.normalized ?? null;
}

/**
 * Both ways to compare one request error. `normalized` (digits as "#",
 * whitespace collapsed) is for keys on one upstream. `exact` is the extracted
 * upstream message (a JSON body's message, a relay's request id dropped), only
 * trimmed and lowercased: for keys on different upstreams, whose limits may
 * differ, so "> 200000 maximum" and "> 1000000 maximum" must not count as the
 * same. `exact` is set only for a context or token limit message
 * (SAME_REQUEST_ERROR_LIMIT_PATTERNS) that names both sizes, two runs of 4+
 * digits such as "12345 tokens > 10000 maximum", and never for a 413. Other
 * messages name no limit (a tool index, a schema draft, a model name are just
 * digits), so the same text from two servers says nothing about a third.
 */
export function requestErrorSignatures(status: number | null | undefined, error: unknown): { normalized: string; exact: string | null } | null {
  if (typeof status !== "number" || !SAME_REQUEST_ERROR_STATUSES.has(status)) return null;
  const raw = asText(error);
  const message = upstreamMessage(raw);
  if (namesTheKey(status, message) || namesTheKey(status, raw)) return null;
  const requestShaped = status === HTTP_STATUS.PAYLOAD_TOO_LARGE || SAME_REQUEST_ERROR_PATTERNS.some((p) => p.test(message));
  if (!requestShaped) return null;
  const namesLimit = status !== HTTP_STATUS.PAYLOAD_TOO_LARGE &&
    SAME_REQUEST_ERROR_LIMIT_PATTERNS.some((p) => p.test(message)) &&
    (message.match(/\d{4,}/g) || []).length >= 2;
  const exact = namesLimit ? `${status} ${message.trim().toLowerCase()}` : null;
  return { normalized: `${status} ${normalizeErrorMessage(raw)}`, exact };
}

/**
 * Whether one upstream's error is the request's own fault, so another provider
 * would refuse the same request: a 400 or 422 whose message reads that way, or
 * a 413 whose message does too. A 413 alone says only that this upstream's
 * limit was passed (an empty body, an edge proxy's HTML page), and another
 * provider's limit may be higher. Never an error about the key.
 */
export function isRequestFault(status: number | null | undefined, error: unknown): boolean {
  if (!requestErrorSignatures(status, error)) return false;
  return status !== HTTP_STATUS.PAYLOAD_TOO_LARGE || SAME_REQUEST_ERROR_PATTERNS.some((p) => p.test(upstreamMessage(error)));
}

/**
 * How far accounts agree: "exact" once `exactAfter` (max(stopAfter, 2))
 * distinct upstreams gave the very same limit message (a stop wherever the
 * keys point), "normalized" once `stopAfter` accounts gave it up to numbers
 * and spacing (a stop only for keys on one upstream), else null.
 */
export type SameRequestErrorAgreement = "exact" | "normalized" | null;

export interface SameRequestErrorTally {
  /** Accounts that must give the same request error to stop; 0 never stops. */
  readonly stopAfter: number;
  /** Distinct upstreams that must give the very same limit message: max(stopAfter, 2). */
  readonly exactAfter: number;
  /**
   * Records one account's failure and says how far accounts agree on it.
   * `upstream` identifies where the account's requests go (src/sse/services/connectionUpstream.ts).
   */
  note(connectionId: string, upstream: string, status: number | null | undefined, error: unknown): SameRequestErrorAgreement;
}

export function createSameRequestErrorTally(stopAfter: number = SAME_REQUEST_ERROR_STOP_AFTER): SameRequestErrorTally {
  const membersBySignature = new Map<string, Set<string>>();
  const agreeing = (signature: string, member: string): number => {
    let members = membersBySignature.get(signature);
    if (!members) membersBySignature.set(signature, (members = new Set()));
    members.add(member);
    return members.size;
  };
  // One upstream agreeing with itself proves nothing about another.
  const exactAfter = Math.max(stopAfter, 2);
  return {
    stopAfter,
    exactAfter,
    note(connectionId, upstream, status, error) {
      if (stopAfter <= 0) return null;
      const signatures = requestErrorSignatures(status, error);
      if (!signatures) return null;
      const normalized = agreeing(`n ${signatures.normalized}`, connectionId);
      if (signatures.exact !== null && agreeing(`x ${signatures.exact}`, upstream) >= exactAfter) return "exact";
      return normalized >= stopAfter ? "normalized" : null;
    },
  };
}
