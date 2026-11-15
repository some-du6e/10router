// A request error every key would refuse (the prompt is longer than the model's
// context window, the upstream rejects a tool schema) fails the same way on
// each account, so walking all of them only costs time. This tallies one
// request's errors per model and says when enough accounts agreed to stop.
import { namesAccountOrLimit } from "./accountFallback.js";
import {
  SAME_REQUEST_ERROR_STOP_AFTER,
  SAME_REQUEST_ERROR_STATUSES,
  SAME_REQUEST_ERROR_MAX_CHARS,
} from "../config/runtimeConfig.js";

/**
 * The error text in a form two keys' copies of one error share: lowercased,
 * every run of digits as "#" (token counts, sizes, ids differ per call),
 * whitespace collapsed, cut to SAME_REQUEST_ERROR_MAX_CHARS.
 */
export function normalizeErrorMessage(error: unknown): string {
  const text = error == null ? "" : typeof error === "string" ? error : JSON.stringify(error);
  return text.toLowerCase().replace(/\d+/g, "#").replace(/\s+/g, " ").trim().slice(0, SAME_REQUEST_ERROR_MAX_CHARS);
}

/**
 * What identifies this failure as a request error for counting, or null when it
 * doesn't count: another status, or a 4xx that names the key, its billing or a
 * limit (those are about the account, and keep today's handling).
 */
export function requestErrorSignature(status: number | null | undefined, error: unknown): string | null {
  if (typeof status !== "number" || !SAME_REQUEST_ERROR_STATUSES.has(status)) return null;
  if (namesAccountOrLimit(error)) return null;
  return `${status} ${normalizeErrorMessage(error)}`;
}

export interface SameRequestErrorTally {
  /** Records one account's failure; true once `stopAfter` distinct accounts gave this same request error. */
  note(connectionId: string, status: number | null | undefined, error: unknown): boolean;
}

export function createSameRequestErrorTally(stopAfter: number = SAME_REQUEST_ERROR_STOP_AFTER): SameRequestErrorTally {
  const accountsBySignature = new Map<string, Set<string>>();
  return {
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
