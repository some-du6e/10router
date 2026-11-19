// An upstream request's body must not stay in memory while its response
// streams. Node's fetch (undici) clones a request it may redirect and keeps an
// unread copy of the body off the JS heap until the response ends, so dozens of
// multi-MB prompts streaming at once held one extra copy each
// (open-sse/utils/proxyFetch.js sends without the clone). Redirects still behave
// as before.
import http from "node:http";
import v8 from "node:v8";
import vm from "node:vm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";
import { BaseExecutor } from "../../open-sse/executors/base.js";

v8.setFlagsFromString("--expose-gc");
const gc = vm.runInNewContext("gc");

const MB = 1024 * 1024;
const BODY_MB = 8;
let server;
let base;
// Responses the server has started and not ended: the streams stay open.
const open = [];
// Path → request count, for the redirect tests.
const hits = new Map();

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const path = new URL(req.url, "http://upstream.test").pathname;
    hits.set(path, (hits.get(path) || 0) + 1);
    let bytes = 0;
    req.on("data", (chunk) => { bytes += chunk.length; });
    req.on("end", () => {
      const moved = /^\/moved-(\d{3})$/.exec(path);
      if (moved) {
        res.writeHead(Number(moved[1]), { location: "/echo" });
        return res.end();
      }
      if (path === "/echo") {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ method: req.method, bytes }));
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n');
      open.push(res);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
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

// A prompt of BODY_MB MB, built here so only the request can keep it.
const prompt = (i) => ({ model: `model-${i}`, stream: true, messages: [{ role: "user", content: String(i % 10).repeat(BODY_MB * MB) }] });

// Buffer memory held while `n` requests stream, and their responses.
async function heldWhileStreaming(n, start) {
  await settle();
  const before = process.memoryUsage().arrayBuffers;
  const responses = [];
  for (let i = 0; i < n; i++) responses.push(await start(i));
  expect(responses.every((r) => r.status === 200)).toBe(true);
  await settle();
  return { held: process.memoryUsage().arrayBuffers - before, responses };
}

async function finish(responses) {
  for (const res of open.splice(0)) res.end("data: [DONE]\n\n");
  await Promise.all(responses.map((r) => r.text()));
}

describe("upstream request body memory", () => {
  it("keeps no copy of a streaming request's body through the executor", async () => {
    const executor = new BaseExecutor("test-upstream", { baseUrl: `${base}/v1/chat/completions` });
    const start = async (i) => (await executor.execute({ model: `model-${i}`, body: prompt(i), stream: true, credentials: { apiKey: "test-key-0000" } })).response;
    // It doesn't grow with the number of streams: unfixed, 2 hold 16 MB and 8 hold 64 MB.
    for (const n of [2, 8]) {
      const { held, responses } = await heldWhileStreaming(n, start);
      expect(held).toBeLessThan(4 * MB);
      await finish(responses);
    }
  }, 60_000);

  it("keeps no copy of a string body sent with proxyAwareFetch", async () => {
    const start = (i) => proxyAwareFetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(prompt(i)),
    });
    const { held, responses } = await heldWhileStreaming(4, start);
    expect(held).toBeLessThan(4 * MB);
    await finish(responses);
  }, 60_000);
});

describe("upstream redirects", () => {
  const post = (path, init = {}) => proxyAwareFetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: '{"x":1}', ...init });

  it.each([307, 308])("follows a %i with the same method and body", async (status) => {
    const res = await post(`/moved-${status}`);
    expect(res.status).toBe(200);
    expect(res.redirected).toBe(true);
    expect(res.url).toBe(`${base}/echo`);
    expect(await res.json()).toEqual({ method: "POST", bytes: 7 });
  });

  it.each([301, 302, 303])("follows a %i as a GET without the body, as fetch does", async (status) => {
    const res = await post(`/moved-${status}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ method: "GET", bytes: 0 });
  });

  // An explicit redirect "follow" is fetch's own behavior, untouched. Node 22's
  // undici can't re-send a byte body on a 307 (it fails), Node 24's can.
  it("redirects a byte body as fetch does", async () => {
    const outcome = (init) => post("/moved-307", { body: new TextEncoder().encode('{"x":1}'), ...init })
      .then((res) => res.json(), (error) => `${error.name}: ${error.cause?.message}`);
    expect(await outcome()).toEqual(await outcome({ redirect: "follow" }));
  });

  it("leaves a caller's own redirect mode alone", async () => {
    hits.clear();
    const manual = await post("/moved-307", { redirect: "manual" });
    expect(manual.status).toBe(307);
    expect(manual.headers.get("location")).toBe("/echo");
    await expect(post("/moved-307", { redirect: "error" })).rejects.toThrow(TypeError);
    // Each sent once: no second try.
    expect(hits.get("/moved-307")).toBe(2);
    expect(hits.get("/echo")).toBeUndefined();
  });

  it("sends a request without a redirect once", async () => {
    hits.clear();
    const res = await post("/echo");
    expect(await res.json()).toEqual({ method: "POST", bytes: 7 });
    expect(hits.get("/echo")).toBe(1);
  });
});
