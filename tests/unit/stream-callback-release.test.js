// Callbacks that stay with a streamed reply until it ends must not keep the
// request they were made for: a custom endpoint's reply filter, and a limit
// hold that resumed into the real stream.
import { describe, expect, it, vi } from "vitest";
import { settle } from "../helpers/heldStreams.js";

const fetchMock = vi.fn();
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: (...a) => fetchMock(...a) }));

const { DefaultExecutor } = await import("../../open-sse/executors/default.js");
const { createLimitHoldResponse } = await import("../../open-sse/utils/limitHold.js");
const { FORMATS } = await import("../../open-sse/translator/formats.js");

const encoder = new TextEncoder();

// An SSE body that sends one chunk and stays open until `end()`.
function openStream(first) {
  let controller;
  const body = new ReadableStream({ start(c) { controller = c; c.enqueue(encoder.encode(first)); } });
  return { body, end: () => controller.close() };
}

const prompt = () => ({ model: "m1", stream: true, messages: [{ role: "user", content: "x".repeat(64 * 1024) }] });

describe("streamed reply callbacks", () => {
  it("a custom endpoint's reply filter keeps no request", async () => {
    const upstream = openStream('data: {"choices":[{"index":0,"delta":{"content":"Hi"}}]}\n\n');
    fetchMock.mockResolvedValue(new Response(upstream.body, { status: 200, headers: { "content-type": "text/event-stream" } }));
    let body = prompt();
    const ref = new WeakRef(body);
    const credentials = { apiKey: "sk-test-1234567890", providerSpecificData: { baseUrl: "https://gw.example.com/v1", blockForeignTools: true, stripReasoning: true } };
    const { response } = await new DefaultExecutor("openai-compatible-chat-x").execute({ model: "m1", body, stream: true, credentials, log: { warn: vi.fn() } });
    body = null;
    const reader = response.body.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("Hi");
    fetchMock.mockReset();
    await settle();
    expect(ref.deref()).toBeUndefined();
    upstream.end();
    for (;;) if ((await reader.read()).done) break;
  });

  it("a limit hold that resumed keeps no request", async () => {
    const upstream = openStream('data: {"choices":[{"index":0,"delta":{"content":"resumed"}}]}\n\n');
    let request = prompt();
    const ref = new WeakRef(request);
    // As chat.ts's hold attempt does: it closes over the request it re-routes.
    const routeFor = (req) => async () => ({ success: req.messages.length > 0, response: new Response(upstream.body, { headers: { "content-type": "text/event-stream" } }) });
    let attempt = routeFor(request);
    request = null;
    const hold = createLimitHoldResponse({
      sourceFormat: FORMATS.OPENAI, model: "m1", provider: "openai", retryAtMs: Date.now(), attempt,
      timing: { minWaitMs: 1, recheckMs: 1, keepaliveMs: 60_000 },
    });
    attempt = null;
    const reader = hold.body.getReader();
    let text = "";
    while (!text.includes("resumed")) text += new TextDecoder().decode((await reader.read()).value);
    await settle();
    expect(ref.deref()).toBeUndefined();
    upstream.end();
    for (;;) if ((await reader.read()).done) break;
  });
});
