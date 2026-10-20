import { ERROR_CLASS, ERROR_RULES } from "../config/errorConfig.js";
import { HTTP_STATUS } from "../config/runtimeConfig.js";
import { isLimitError } from "./limitHold.js";

const CLIENT_CLOSED_REQUEST = 499;
// Whole words only: "stall" must not match "install", and a 400 about a bad
// `timeout` parameter is not a timeout.
const TIMEOUT_PATTERN = /\b(timed out|etimedout|und_err_(connect|headers|body)_timeout|(connect|headers|read|request) timeout|stalled?)\b/;
// Same text the account cooldown treats as a limit (too many requests, overloaded…),
// so the dashboard's class agrees with how the account was cooled down.
const BACKOFF_TEXT = ERROR_RULES.filter((r) => r.text && r.backoff).map((r) => r.text);

/**
 * Bucket a failed request into one ERROR_CLASS value from its status and message.
 * Order matters: limit text beats status (some providers send quota errors as 403/400),
 * timeout text beats 5xx (a 502 from a connect timeout is still a timeout).
 */
export function classifyError(status, message = "") {
  const text = typeof message === "string" ? message.toLowerCase() : "";
  if (status === CLIENT_CLOSED_REQUEST) return ERROR_CLASS.ABORTED;
  if (isLimitError(status, text) || BACKOFF_TEXT.some((t) => text.includes(t))) return ERROR_CLASS.RATE_LIMITED;
  if (status === HTTP_STATUS.UNAUTHORIZED || status === HTTP_STATUS.FORBIDDEN) return ERROR_CLASS.AUTH_ERROR;
  if (status === HTTP_STATUS.GATEWAY_TIMEOUT || status === HTTP_STATUS.REQUEST_TIMEOUT || TIMEOUT_PATTERN.test(text)) return ERROR_CLASS.TIMEOUT;
  if (status >= 500) return ERROR_CLASS.UPSTREAM_5XX;
  if (status >= 400) return ERROR_CLASS.CLIENT_ERROR;
  return ERROR_CLASS.OTHER;
}

/** Message text for classifyError from a thrown fetch error, including its low-level cause. */
export function errorText(error) {
  return [error?.message, error?.cause?.code, error?.cause?.message].filter(Boolean).join(" ");
}
