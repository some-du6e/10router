import {
  ERROR_CLASS, ERROR_RULES, LIMIT_REFUSAL, MODEL_REFUSAL, OPERATION_REFUSAL, BAD_KEY_TEXTS, BILLING_TEXTS,
  TIMEOUT_PATTERN, NETWORK_PATTERN, ERROR_CLASS_MAX_TEXT,
} from "../config/errorConfig.js";
import { HTTP_STATUS } from "../config/runtimeConfig.js";
import { isLimitError } from "./limitHold.js";
import { errorCauseParts } from "./error.js";

const BACKOFF_TEXTS = ERROR_RULES.filter((r) => r.backoff && r.text).map((r) => r.text);

/** Error text the account cooldown backs off on (rate limit, too many requests, capacity, overloaded…). */
export const isBackoffText = (text) => {
  const lower = typeof text === "string" ? text.toLowerCase() : "";
  return BACKOFF_TEXTS.some((t) => lower.includes(t));
};

const LIMIT_TEXT = new RegExp(LIMIT_REFUSAL.map((r) => r.source).join("|"), "i");
const includesAny = (text, list) => list.some((t) => text.includes(t));
const toText = (message) => (typeof message === "string" ? message.slice(0, ERROR_CLASS_MAX_TEXT).toLowerCase() : "");

/**
 * Bucket an upstream HTTP failure into one ERROR_CLASS value from its status and
 * message. Uses the same text lists the account cooldown and auth-failure
 * tracking use (ERROR_RULES backoff texts, LIMIT_REFUSAL, MODEL_REFUSAL,
 * OPERATION_REFUSAL, BAD_KEY_TEXTS, BILLING_TEXTS). Order:
 * 499 (timeout text, else aborted) → limit/billing → refusal of one model →
 * auth → timeout → 5xx → other 4xx. Never throws.
 */
export function classifyError(status, message = "") {
  const code = Number(status);
  const text = toText(message);
  if (code === HTTP_STATUS.CLIENT_CLOSED_REQUEST) return TIMEOUT_PATTERN.test(text) ? ERROR_CLASS.TIMEOUT : ERROR_CLASS.ABORTED;

  const accountStatus = code === HTTP_STATUS.UNAUTHORIZED || code === HTTP_STATUS.FORBIDDEN;
  // Backoff text ("capacity", "overloaded") only means a limit where a limit can
  // come from: a 400 "prompt exceeds context capacity" is the request's fault.
  const backoffStatus = code === HTTP_STATUS.FORBIDDEN || code === HTTP_STATUS.RATE_LIMITED || code >= HTTP_STATUS.SERVER_ERROR;
  if (
    code === HTTP_STATUS.PAYMENT_REQUIRED
    || isLimitError(code, text)
    || includesAny(text, BILLING_TEXTS)
    || (backoffStatus && isBackoffText(text))
    || (accountStatus && LIMIT_TEXT.test(text))
  ) return ERROR_CLASS.RATE_LIMITED;

  if ((code === HTTP_STATUS.FORBIDDEN || code === HTTP_STATUS.NOT_FOUND) && MODEL_REFUSAL.test(text)) return ERROR_CLASS.CLIENT_ERROR;
  if (accountStatus || OPERATION_REFUSAL.test(text) || includesAny(text, BAD_KEY_TEXTS)) return ERROR_CLASS.AUTH_ERROR;
  if (code === HTTP_STATUS.GATEWAY_TIMEOUT || code === HTTP_STATUS.REQUEST_TIMEOUT || TIMEOUT_PATTERN.test(text)) return ERROR_CLASS.TIMEOUT;
  if (code >= HTTP_STATUS.SERVER_ERROR) return ERROR_CLASS.UPSTREAM_5XX;
  if (code >= HTTP_STATUS.BAD_REQUEST) return ERROR_CLASS.CLIENT_ERROR;
  return ERROR_CLASS.OTHER;
}

/**
 * Bucket an error thrown by an executor (no upstream response). The local 502
 * chatCore answers with says nothing about the upstream, so it isn't used:
 * timeout text → timeout, AbortError → aborted, a connection failure → network_error,
 * anything else (a bug in our code) → other. Never throws.
 */
export function classifyThrownError(error) {
  const text = toText(errorText(error));
  if (TIMEOUT_PATTERN.test(text)) return ERROR_CLASS.TIMEOUT;
  if (safeName(error) === "AbortError") return ERROR_CLASS.ABORTED;
  if (NETWORK_PATTERN.test(text)) return ERROR_CLASS.NETWORK_ERROR;
  return ERROR_CLASS.OTHER;
}

function safeName(error) {
  try { return typeof error?.name === "string" ? error.name : ""; } catch { return ""; }
}

/** Text to classify from a thrown error: its message plus its low-level cause. String parts only; never throws. */
export function errorText(error) {
  try {
    const message = typeof error?.message === "string" ? error.message : "";
    return [message, ...errorCauseParts(error)].filter(Boolean).join(" ");
  } catch {
    return "";
  }
}
