/**
 * Let go of the proxy's (middleware's) copy of a request body.
 *
 * Next feeds the proxy a copy of the body stream, pushed the same chunks as the
 * one the route reads (getCloneableBody in next/dist/server/body-streams.js).
 * The proxy never reads it, and the request keeps it reachable until its
 * response ends, so every request held its whole body a second time after the
 * route had parsed it: while it waited for a warm key or another account, and
 * while its reply streamed. Reading the copy as it arrives frees each chunk.
 *
 * Not awaited: Next waits for the whole body before the route runs anyway, and
 * a copy whose upload was cut off never ends. Never throws.
 *
 * @param {Request} request - the proxy's request
 */
export function releaseBodyCopy(request) {
  let body;
  try {
    body = request?.body;
    if (!body || body.locked) return;
    const reader = body.getReader();
    (async () => {
      while (!(await reader.read()).done);
    })().catch(() => {});
  } catch {
    // A body that can't be read here is left to Next.
  }
}
