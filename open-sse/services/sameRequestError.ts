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
  if (typeof status !== "number" || !SAME_REQUEST_ERROR_STATUSES.has(status)) return null;
  const raw = asText(error);
  const message = upstreamMessage(raw);
  if (namesTheKey(status, message) || namesTheKey(status, raw)) return null;
  const requestShaped = status === HTTP_STATUS.PAYLOAD_TOO_LARGE || SAME_REQUEST_ERROR_PATTERNS.some((p) => p.test(message));
  if (!requestShaped) return null;
  return `${status} ${normalizeErrorMessage(raw)}`;
}

export interface SameRequestErrorTally {
  /** Accounts that must give the same request error to stop; 0 never stops. */
  readonly stopAfter: number;
  /** Records one account's failure; true once `stopAfter` distinct accounts gave this same request error. */
  note(connectionId: string, status: number | null | undefined, error: unknown): boolean;
}

export function createSameRequestErrorTally(stopAfter: number = SAME_REQUEST_ERROR_STOP_AFTER): SameRequestErrorTally {
  const accountsBySignature = new Map<string, Set<string>>();
  return {
    stopAfter,
    note(connectionId, status, error) {
      if (stopAfter <= 0) return false;
      const signature = requestErrorSignature(status, error);
      if (signature === null) return false;
      let accounts = accountsBySignature.get(signature);
      if (!accounts) accountsBySignature.set(signature, (accounts = new Set()));
      accounts.add(connectionId);
      return accounts.size >= stopAfter;
    },
  };
}
