import { statsEmitter, getActiveRequests } from "@/lib/usageDb";

export const dynamic = "force-dynamic";

const PING = new TextEncoder().encode(": ping\n\n");

// The dashboard merges only these fields from the stream; full stats come
// from /api/usage/stats.
async function liveFrame(encoder) {
  const { activeRequests, recentRequests, errorProvider, pending } = await getActiveRequests();
  return encoder.encode(`data: ${JSON.stringify({ activeRequests, recentRequests, errorProvider, pending })}\n\n`);
}

export async function GET(request) {
  const encoder = new TextEncoder();
  let controller;
  let closed = false;
  let keepalive = null;
  let latest = null;

  // Next.js disconnects can abort the request without canceling the response body.
  const cleanup = () => {
    if (closed) return;
    closed = true;
    latest = null;
    statsEmitter.off("update", push);
    statsEmitter.off("pending", push);
    clearInterval(keepalive);
    request.signal.removeEventListener("abort", cleanup);
    try { controller.close(); } catch {}
  };

  // A client that stops reading (a sleeping laptop) keeps only the newest
  // frame waiting instead of one per event; pull() sends it once it reads again.
  const write = (bytes, keepLatest) => {
    if (closed) return;
    try {
      if (controller.desiredSize > 0) controller.enqueue(bytes);
      else if (keepLatest) latest = bytes;
    } catch {
      cleanup();
    }
  };

  async function push() {
    if (closed) return;
    try {
      write(await liveFrame(encoder), true);
    } catch {
      cleanup();
    }
  }

  request.signal.addEventListener("abort", cleanup, { once: true });

  const stream = new ReadableStream({
    async start(c) {
      controller = c;
      if (request.signal.aborted) return cleanup();

      await push();
      if (closed) return;

      statsEmitter.on("update", push);
      statsEmitter.on("pending", push);
      keepalive = setInterval(() => write(PING, false), 25000);
    },

    pull(c) {
      if (!latest) return;
      const bytes = latest;
      latest = null;
      c.enqueue(bytes);
    },

    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
