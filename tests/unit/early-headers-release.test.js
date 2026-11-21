// The early-headers wrapper forwards the client's hang-up to `run` through a
// listener that stays on the client's signal until the request ends. That
// listener must not keep `run`, and with it the parsed request `run` closes
// over, for the whole of a streamed reply.
import v8 from "node:v8";
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { respondWithEarlyHeaders } from "../../open-sse/utils/earlyHeaders.js";

v8.setFlagsFromString("--expose-gc");
const gc = vm.runInNewContext("gc");

const settle = async () => {
  for (let i = 0; i < 3; i++) {
    gc();
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

// A route that closes over its request, as handleChat's does.
function routeFor(request) {
  return async (signal) => new Response(`${request.messages.length} ${signal.aborted}`, { headers: { "content-type": "text/event-stream" } });
}

describe("early headers", () => {
  it.each([
    ["answered before the delay", 0],
    ["answered after early headers", 5],
  ])("keep nothing run closes over once it has answered: %s", async (_, delayMs) => {
    const client = new AbortController();
    let request = { messages: [{ role: "user", content: "x".repeat(1024) }] };
    const ref = new WeakRef(request);
    let run = routeFor(request);
    request = null;
    let slow = delayMs ? async (signal) => { await new Promise((r) => setTimeout(r, 20)); return run(signal); } : run;
    const response = await respondWithEarlyHeaders({ run: slow, sourceFormat: "claude", signal: client.signal, delayMs, keepaliveMs: 1000 });
    const text = await response.text();
    expect(text).toContain("1 false");
    run = null;
    slow = null;
    await settle();
    expect(ref.deref()).toBeUndefined();
    // The client's request is still open: the hang-up still reaches run's signal.
    expect(client.signal.aborted).toBe(false);
  });

  it("still forwards a hang-up to run's signal", async () => {
    const client = new AbortController();
    let seen = null;
    const pending = respondWithEarlyHeaders({ run: async (signal) => { seen = signal; return new Response("ok"); }, sourceFormat: "claude", signal: client.signal, delayMs: 0 });
    await pending;
    client.abort();
    expect(seen.aborted).toBe(true);
  });
});
