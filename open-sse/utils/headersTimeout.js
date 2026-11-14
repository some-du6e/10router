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

/**
 * Aborts a fetch whose response headers haven't arrived within timeoutMs.
 * `error()` is the UpstreamHeadersTimeoutError when the timer (not the client's
 * signal) ended the fetch, else null.
 */
export function headersTimer(timeoutMs, clientSignal, details) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new UpstreamHeadersTimeoutError(timeoutMs, details)), timeoutMs);
  return {
    signal: clientSignal ? AbortSignal.any([clientSignal, ctrl.signal]) : ctrl.signal,
    clear: () => clearTimeout(timer),
    error: () => (ctrl.signal.aborted && !clientSignal?.aborted ? ctrl.signal.reason : null),
  };
}
