import { statsEmitter, getActiveRequests } from "@/lib/usageDb";

export const dynamic = "force-dynamic";

const PING = new TextEncoder().encode(": ping\n\n");
const HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  Connection: "keep-alive",
};

// The dashboard merges only these fields from the stream; full stats come
// from /api/usage/stats.
async function liveFrame(encoder) {
  const { activeRequests, recentRequests, errorProvider, pending } = await getActiveRequests();
  return encoder.encode(`data: ${JSON.stringify({ activeRequests, recentRequests, errorProvider, pending })}\n\n`);
}

// Next runs GET for HEAD unless HEAD is exported, and a HEAD body is never read
// or cancelled, so it must not open a stream.
export function HEAD() {
  return new Response(null, { headers: HEADERS });
}

export async function GET(request) {
  if (request.method === "HEAD") return HEAD();

  const encoder = new TextEncoder();
  let controller;
  let closed = false;
  let keepalive = null;
  // Events arrived while the client wasn't reading; pull() sends one fresh frame.
  let dirty = false;

  // Next.js disconnects can abort the request without canceling the response body.
  const cleanup = () => {
    if (closed) return;
    closed = true;
    statsEmitter.off("update", push);
    statsEmitter.off("pending", push);
    clearInterval(keepalive);
    request.signal.removeEventListener("abort", cleanup);
    try { controller.close(); } catch {}
  };

  // A client that stops reading (a sleeping laptop) gets no frames or pings
  // queued for it, and costs no reads until it reads again.
  const write = (bytes, isFrame) => {
    if (closed) return;
    try {
      if (controller.desiredSize > 0) controller.enqueue(bytes);
      else if (isFrame) dirty = true;
    } catch {
      cleanup();
    }
  };

  async function push() {
    if (closed) return;
    if (controller.desiredSize <= 0) {
      dirty = true;
      return;
    }
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

    async pull() {
      if (!dirty || closed) return;
      dirty = false;
      await push();
    },

    cancel() {
      cleanup();
    },
  });

  return new Response(stream, { headers: HEADERS });
}
