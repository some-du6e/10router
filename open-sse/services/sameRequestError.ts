// A request error every key would refuse (the prompt is longer than the model's
// context window, the upstream rejects a tool schema) fails the same way on
// each account, so walking all of them only costs time. This tallies one
// request's errors per model and says when enough accounts agreed to stop.
import { namesAccountOrLimit } from "./accountFallback.js";
import { isLimitError } from "../utils/limitHold.js";
import { SAME_REQUEST_ERROR_STOP_AFTER, SAME_REQUEST_ERROR_STATUSES } from "../config/runtimeConfig.js";
import { ERROR_CLASS_MAX_TEXT, LIMIT_REFUSAL, MODEL_REFUSAL, OPERATION_REFUSAL } from "../config/errorConfig.js";

// A limit, or a refusal of one model or operation: about the key, not the request.
const KEY_REFUSAL = new RegExp([...LIMIT_REFUSAL, MODEL_REFUSAL, OPERATION_REFUSAL].map((r) => r.source).join("|"), "i");

const asText = (error: unknown): string =>
  error == null ? "" : typeof error === "string" ? error : JSON.stringify(error);

/**
 * The upstream's message: chatCore's "[400]: " prefix dropped, and from a JSON
 * body its error.message, else message, else error (the order parseUpstreamError
 * reads them in), so per-call fields such as a request id don't take part.
 */
export function upstreamMessage(error: unknown): string {
  const text = asText(error).replace(/^\[\d+\]:\s*/, "");
  let json: { error?: { message?: unknown } | unknown; message?: unknown } | null = null;
  try { json = JSON.parse(text); } catch { return text; }
  if (!json || typeof json !== "object") return text;
  const message = (json.error as { message?: unknown } | undefined)?.message || json.message || json.error;
  return message ? asText(message) : text;
}

/**
 * The message in a form two keys' copies of one error share: lowercased, every
 * run of digits as "#" (token counts and sizes differ per call), whitespace
 * collapsed. Only the first ERROR_CLASS_MAX_TEXT characters are read.
 */
export function normalizeErrorMessage(error: unknown): string {
  return upstreamMessage(error).slice(0, ERROR_CLASS_MAX_TEXT).toLowerCase().replace(/\d+/g, "#").replace(/\s+/g, " ").trim();
}

/**
 * What identifies this failure as a request error for counting, or null when it
 * doesn't count: another status, or a 4xx that names the key, its billing, a
 * limit, or a refusal of one model or operation (those are about the account,
 * and keep today's handling).
 */
export function requestErrorSignature(status: number | null | undefined, error: unknown): string | null {
  if (typeof status !== "number" || !SAME_REQUEST_ERROR_STATUSES.has(status)) return null;
  const text = asText(error).slice(0, ERROR_CLASS_MAX_TEXT);
  if (namesAccountOrLimit(text) || isLimitError(status, text) || KEY_REFUSAL.test(text)) return null;
  return `${status} ${normalizeErrorMessage(error)}`;
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
