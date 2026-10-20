import { ERROR_CLASS } from "../config/errorConfig.js";
import { HTTP_STATUS } from "../config/runtimeConfig.js";
import { isLimitError } from "./limitHold.js";

const TIMEOUT_TEXT = ["timeout", "timed out", "etimedout", "stall"];

/**
 * Bucket a failed request into one ERROR_CLASS value from its status and message.
 * Order matters: limit text beats status (some providers send quota errors as 403/400),
 * timeout text beats 5xx (a 502 from a connect timeout is still a timeout).
 */
export function classifyError(status, message = "") {
  const text = typeof message === "string" ? message.toLowerCase() : "";
  if (isLimitError(status, text)) return ERROR_CLASS.RATE_LIMITED;
  if (status === HTTP_STATUS.UNAUTHORIZED || status === HTTP_STATUS.FORBIDDEN) return ERROR_CLASS.AUTH_LOCKED;
  if (status === HTTP_STATUS.GATEWAY_TIMEOUT || TIMEOUT_TEXT.some((t) => text.includes(t))) return ERROR_CLASS.TIMEOUT;
  if (status >= 500) return ERROR_CLASS.UPSTREAM_5XX;
  if (status >= 400) return ERROR_CLASS.CLIENT_ERROR;
  return ERROR_CLASS.OTHER;
}
