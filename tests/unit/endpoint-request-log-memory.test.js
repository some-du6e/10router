// A custom endpoint's "Recent requests" capture (src/lib/endpointRequestLog.ts)
// keeps at most MAX_CAPTURE_BYTES of each request body while that request
// runs. Under load, many multi-MB prompts are in flight at once, waiting on
// prefill or streaming, so a capture that kept the whole body would hold one
// extra copy of every prompt outside the JS heap.
import http from "node:http";
import v8 from "node:v8";
import vm from "node:vm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { recordEndpointRequests, getEndpointRequests, clearEndpointRequests } from "../../src/lib/endpointRequestLog.ts";
import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";

v8.setFlagsFromString("--expose-gc");
const gc = vm.runInNewContext("gc");

const MB = 1024 * 1024;
const EP = "openai-compatible-test-capture";
const IN_FLIGHT = 4;
const BODY_MB = 8;
let server;
let base;
// Responses the server has started and not ended: the streams stay open.
const open = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n');
      open.push(res);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}/v1`;
});
afterAll(() => {
  for (const res of open) res.destroy();
  server?.close();
});

const settle = async () => {
  for (let i = 0; i < 3; i++) {
    gc();
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

// The body types an executor sends: JSON text, or its encoded bytes.
const BODY_KINDS = {
  string: (json) => json,
  Uint8Array: (json) => new TextEncoder().encode(json),
};

// One request whose prompt is `BODY_MB` MB, sent and answered with headers; its
// stream stays open. The body is built here, so only the fetch (and, with
// `capture`, the endpoint log) can keep it.
function startRequest(i, kind, capture) {
  const json = JSON.stringify({ model: `model-${i}`, stream: true, messages: [{ role: "user", content: String(i).repeat(BODY_MB * MB) }] });
  const send = () => proxyAwareFetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: BODY_KINDS[kind](json),
  });
  if (!capture) return send();
  const creds = { apiKey: "test-key-0000000000", providerSpecificData: { baseUrl: base } };
  return recordEndpointRequests(EP, creds, send);
}

// Buffer memory held while IN_FLIGHT requests stream, and their responses.
async function heldWhileRunning(kind, capture) {
  await settle();
  const before = process.memoryUsage().arrayBuffers;
  const responses = [];
  for (let i = 0; i < IN_FLIGHT; i++) responses.push(await startRequest(i, kind, capture));
  expect(responses.every((r) => r.status === 200)).toBe(true);
  await settle();
  return { held: process.memoryUsage().arrayBuffers - before, responses };
}

async function finish(responses) {
  for (const res of open.splice(0)) res.end("data: [DONE]\n\n");
  await Promise.all(responses.map((r) => r.text()));
}

describe("endpoint request log memory", () => {
  it.each(Object.keys(BODY_KINDS))("keeps only a capped copy of each running request's %s body", async (kind) => {
    clearEndpointRequests(EP);
    // What the fetches themselves hold, without the log.
    const plain = await heldWhileRunning(kind, false);
    await finish(plain.responses);

    const logged = await heldWhileRunning(kind, true);
    // Whole bodies would add IN_FLIGHT x BODY_MB (32 MB); capped ones add 256 KB each.
    expect(logged.held - plain.held).toBeLessThan(4 * MB);
    // Still running: nothing is logged before its response ends.
    expect(getEndpointRequests(EP)).toEqual([]);
    await finish(logged.responses);

    // The response clone is read after the caller's.
    await vi.waitFor(() => expect(getEndpointRequests(EP)).toHaveLength(IN_FLIGHT));
    for (const entry of getEndpointRequests(EP)) {
      expect(entry).toMatchObject({ ok: true, status: 200, reply: "Hi" });
      expect(entry.request).toMatch(/^POST http:\/\/127\.0\.0\.1:\d+\/v1\/chat\/completions/);
      expect(entry.request).toContain('{"model":"model-');
      expect(entry.request).toMatch(/more characters\)$/);
    }
  }, 60_000);

  // A kept entry shows 8000 characters of each body; it must not keep the 256 KB
  // capture they were cut from (a long slice keeps its whole source string).
  it("keeps only the shown text of a finished entry", async () => {
    clearEndpointRequests(EP);
    const creds = { apiKey: "test-key-0000000000", providerSpecificData: { baseUrl: base } };
    const n = 10;
    await settle();
    const before = process.memoryUsage().heapUsed;
    for (let i = 0; i < n; i++) {
      const response = await recordEndpointRequests(EP, creds, () => proxyAwareFetch(`${base}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: `model-${i}`, messages: [{ role: "user", content: `${i}`.repeat(MB) }] }),
      }));
      await finish([response]);
    }
    await vi.waitFor(() => expect(getEndpointRequests(EP)).toHaveLength(n));
    await settle();
    // n captures of 256 KB would be 2.5 MB; the shown text is about 8 KB each.
    expect(process.memoryUsage().heapUsed - before).toBeLessThan(n * 128 * 1024);
    expect(getEndpointRequests(EP)[0].request).toMatch(/more characters\)$/);
  }, 60_000);

  // 256 K characters of a two-byte character encode to 512 KB, so the capture
  // has to cut again in bytes: 256 KB is exactly 131072 "é".
  it("cuts a multi-byte body to 256 KB", async () => {
    clearEndpointRequests(EP);
    const creds = { apiKey: "test-key-0000000000", providerSpecificData: { baseUrl: base } };
    const response = await recordEndpointRequests(EP, creds, () => proxyAwareFetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "text/plain; charset=utf-8" },
      body: "é".repeat(300_000),
    }));
    await finish([response]);
    await vi.waitFor(() => expect(getEndpointRequests(EP)).toHaveLength(1));
    const [entry] = getEndpointRequests(EP);
    // The entry shows the first 8000 characters (MAX_TEXT) and counts the rest.
    const shown = 8000;
    const more = Number(/\((\d+) more characters\)$/.exec(entry.request)?.[1]);
    expect(shown + more).toBe(131_072);
    expect(entry.request).toContain(`\n\n${"é".repeat(shown)}\n…`);
    expect(entry.request).not.toContain("�");
  }, 30_000);
});
