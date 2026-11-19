import { HTTP_STATUS } from "../config/runtimeConfig.js";
import { HEADERS_TIMEOUT } from "../config/errorConfig.js";

const NAME = "UpstreamHeadersTimeoutError";

// stream: whether the call streamed; setBy: the setting that chose timeoutMs.
export class UpstreamHeadersTimeoutError extends Error {
  constructor(timeoutMs, { stream = false, setBy = null } = {}) {
    super(`${HEADERS_TIMEOUT.text} in ${Math.round(timeoutMs / 1000)}s (headers timeout${setBy ? `, set by ${setBy}` : ""})`);
    this.name = NAME;
    this.status = HTTP_STATUS.GATEWAY_TIMEOUT;
    this.stream = stream;
  }
}

export function isUpstreamHeadersTimeout(error) {
  return error?.name === NAME;
}

// undici's own headers timeout (its UND_ERR_HEADERS_TIMEOUT), on the error or
// down its causes (fetch's TypeError, a wrapper's cause).
export function isUndiciHeadersTimeout(error, depth = 3) {
  if (!error || depth < 0) return false;
  return error.code === "UND_ERR_HEADERS_TIMEOUT" || isUndiciHeadersTimeout(error.cause, depth - 1);
}

/**
 * Aborts a fetch whose response headers haven't arrived within timeoutMs.
 * `error(caught)` is the UpstreamHeadersTimeoutError when the timer (not the
 * client's signal) ended the fetch, or when undici's own headers timeout did
 * (`caught`); else null.
 */
export function headersTimer(timeoutMs, clientSignal, details) {
  const startedAt = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new UpstreamHeadersTimeoutError(timeoutMs, details)), timeoutMs);
  return {
    signal: clientSignal ? AbortSignal.any([clientSignal, ctrl.signal]) : ctrl.signal,
    clear: () => clearTimeout(timer),
    error: (caught) => {
      if (ctrl.signal.aborted && !clientSignal?.aborted) return ctrl.signal.reason;
      if (isUndiciHeadersTimeout(caught)) {
        return new UpstreamHeadersTimeoutError(Date.now() - startedAt, { ...details, setBy: "the HTTP client's own headers timeout" });
      }
      return null;
    },
  };
}
