import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";
import { formatAccountLimitMessage } from "./accountFailureSummary.js";

// Only final, confirmed limit exhaustion is terminal. Keep upstream statuses
// through account/model fallback and leave transport/server failures retryable.
export function finalizeRoutingError(response, { clientTool = null, routingFailures = [] } = {}) {
  if (clientTool !== "codex" || response.ok || !routingFailures.length ||
      !routingFailures.every(failure => failure.limited === true)) return response;

  const resets = routingFailures.map(failure => failure.resetAtMs);
  const resetAtMs = resets.every(time => Number.isFinite(time) && time > Date.now())
    ? Math.min(...resets) : null;
  const headers = new Headers(response.headers);
  const retryAfter = headers.get("retry-after");
  headers.delete("retry-after");
  headers.delete("content-length");
  headers.delete("content-encoding");
  headers.set("content-type", "text/plain; charset=utf-8");
  headers.set("x-should-retry", "false");
  headers.set("x-10router-upstream-status", String(response.status));
  if (retryAfter) headers.set("x-10router-retry-after", retryAfter);
  response.body?.cancel().catch(() => {});
  return new Response(formatAccountLimitMessage(resetAtMs), { status: HTTP_STATUS.BAD_REQUEST, headers });
}
