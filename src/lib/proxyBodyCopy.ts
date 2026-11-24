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
 */
export function releaseBodyCopy(request: Pick<Request, "body"> | null | undefined): void {
  try {
    const body = request?.body;
    if (body && !body.locked) body.pipeTo(new WritableStream()).catch(() => {});
  } catch {
    // A body that can't be read here is left to Next.
  }
}
