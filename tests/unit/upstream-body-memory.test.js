// An upstream request's body must not stay in memory while its response
// streams. Node's fetch (undici) clones a request it may redirect and keeps an
// unread copy of the body off the JS heap until the response ends, so dozens of
// multi-MB prompts streaming at once held one extra copy each
// (open-sse/utils/proxyFetch.js sends without the clone). Redirects still behave
// as before.
import { createHash } from "node:crypto";
import http from "node:http";
import v8 from "node:v8";
import vm from "node:vm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";
import { BaseExecutor } from "../../open-sse/executors/base.js";
import { MEMORY_CONFIG } from "../../open-sse/config/runtimeConfig.js";

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
    const hash = createHash("sha1");
    req.on("data", (chunk) => { bytes += chunk.length; hash.update(chunk); });
    req.on("end", () => {
      const moved = /^\/moved-(wire-)?(\d{3})$/.exec(path);
      if (moved) {
        res.writeHead(Number(moved[2]), { location: moved[1] ? "/wire" : "/echo" });
        return res.end();
      }
      // 421 on the first request (or every one, for /misdirected-always).
      if (path === "/misdirected-always" || (path === "/misdirected-once" && hits.get(path) === 1)) {
        res.writeHead(421, { "content-type": "text/plain" });
        return res.end("misdirected");
      }
      if (path === "/wire") {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ bytes, length: req.headers["content-length"], chunked: "transfer-encoding" in req.headers, type: req.headers["content-type"], sha: hash.digest("hex") }));
      }
      if (path === "/echo" || path === "/misdirected-once") {
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
    // The same bound at 2 and 8 streams: it doesn't grow with them. Without the
    // fix each stream holds its whole body, so 2 already hold 16.0 MB.
    for (const n of [2, 8]) {
      const { held, responses } = await heldWhileStreaming(n, start);
      expect(held).toBeLessThan(4 * MB);
      await finish(responses);
    }
  }, 60_000);

  // fetch keeps a string body on its request as the source it could send
  // again, on the JS heap, until the response ends.
  it("keeps no heap copy of a streaming request's string body", async () => {
    const executor = new BaseExecutor("test-upstream", { baseUrl: `${base}/v1/chat/completions` });
    await settle();
    const before = process.memoryUsage().heapUsed;
    const responses = [];
    for (let i = 0; i < 4; i++) {
      responses.push((await executor.execute({ model: `model-${i}`, body: prompt(i), stream: true, credentials: { apiKey: "test-key-0000" } })).response);
    }
    expect(responses.every((r) => r.status === 200)).toBe(true);
    await settle();
    // Each body's JSON is BODY_MB MB of one-byte characters.
    expect(process.memoryUsage().heapUsed - before).toBeLessThan(4 * MB);
    await finish(responses);
  }, 60_000);

  const IN_FLIGHT = 4;
  const send = (body, init = {}) => proxyAwareFetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    ...init,
  });

  it("keeps no copy of a string body sent with proxyAwareFetch", async () => {
    const { held, responses } = await heldWhileStreaming(IN_FLIGHT, (i) => send(JSON.stringify(prompt(i))));
    expect(held).toBeLessThan(4 * MB);
    await finish(responses);
  }, 60_000);

  // undici copies a byte body when it takes it. Node 22's undici (6.x) moves that
  // copy into the stream, so nothing stays; Node 24's (7.x) keeps it as the
  // body's source: one body per stream, against two with the clone.
  it("keeps at most one copy of a byte body, one fewer than with the clone", async () => {
    const bytes = (i) => new TextEncoder().encode(JSON.stringify(prompt(i)));
    const cloned = await heldWhileStreaming(IN_FLIGHT, (i) => send(bytes(i), { redirect: "follow" }));
    await finish(cloned.responses);
    const { held, responses } = await heldWhileStreaming(IN_FLIGHT, (i) => send(bytes(i)));
    await finish(responses);
    expect(held).toBeLessThan(cloned.held - (IN_FLIGHT * BODY_MB - 4) * MB);
    if (Number(process.versions.undici.split(".")[0]) < 7) expect(held).toBeLessThan(4 * MB);
    else expect(held).toBeLessThan((IN_FLIGHT * BODY_MB + 4) * MB);
  }, 60_000);
});

const sha1 = (body) => createHash("sha1").update(body).digest("hex");

describe("upstream redirects", () => {
  const post = (path, init = {}) => proxyAwareFetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: '{"x":1}', ...init });

  // The redirecting URL gets the request twice: the send without the clone,
  // then the one that follows.
  const expectSentTwiceThenFollowed = (status) => {
    expect(hits.get(`/moved-${status}`)).toBe(2);
    expect(hits.get("/echo")).toBe(1);
  };

  it.each([307, 308])("follows a %i with the same method and body", async (status) => {
    hits.clear();
    const res = await post(`/moved-${status}`);
    expect(res.status).toBe(200);
    expect(res.redirected).toBe(true);
    expect(res.url).toBe(`${base}/echo`);
    expect(await res.json()).toEqual({ method: "POST", bytes: 7 });
    expectSentTwiceThenFollowed(status);
  });

  it.each([301, 302, 303])("follows a %i as a GET without the body, as fetch does", async (status) => {
    hits.clear();
    const res = await post(`/moved-${status}`);
    expect(res.status).toBe(200);
    expect(res.redirected).toBe(true);
    expect(res.url).toBe(`${base}/echo`);
    expect(await res.json()).toEqual({ method: "GET", bytes: 0 });
    expectSentTwiceThenFollowed(status);
  });

  // fetch retries a 421 once on a new connection, re-sending the body.
  it("retries a 421 as fetch does", async () => {
    hits.clear();
    const res = await post("/misdirected-once");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ method: "POST", bytes: 7 });
  });

  it("returns a repeated 421 as fetch does", async () => {
    const plain = await post("/misdirected-always", { redirect: "follow" });
    const res = await post("/misdirected-always");
    expect(res.status).toBe(421);
    expect(await res.text()).toBe("misdirected");
    expect(plain.status).toBe(421);
    expect(await plain.text()).toBe("misdirected");
  });

  // Executors send their body's bytes. Node 22's fetch can't send a byte body
  // again on a 307 or 308 (Node 24's can), so the follow gets a Blob of them.
  it.each([307, 308])("follows a %i with a byte body, small or streamed, keeping its Content-Type", async (status) => {
    const big = Buffer.alloc(MEMORY_CONFIG.streamedBodyMinChars + 64, 120);
    const bodies = [
      // Small: from Buffer's shared pool, a view into a larger allocation.
      Buffer.from('{"x":1}', "utf8"),
      // A view at an offset into a larger buffer, past the stream threshold.
      big.subarray(32, big.length - 22),
    ];
    for (const body of bodies) {
      hits.clear();
      const copy = Buffer.from(body);
      const res = await post(`/moved-wire-${status}`, { body });
      expect(res.status).toBe(200);
      expect(res.redirected).toBe(true);
      expect(await res.json()).toEqual({ bytes: body.length, length: String(body.length), chunked: false, type: "application/json", sha: sha1(copy) });
      expect(hits.get(`/moved-wire-${status}`)).toBe(2);
      // The caller's bytes are left as they were.
      expect(body.equals(copy)).toBe(true);
    }
  });

  it("adds no Content-Type to a byte body that has none when it follows a redirect", async () => {
    const body = Buffer.from('{"x":1}', "utf8");
    const res = await post("/moved-wire-307", { body, headers: {} });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ bytes: 7, length: "7", chunked: false, sha: sha1(body) });
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

  // A large string goes out as a stream of its bytes: with the Content-Length
  // and Content-Type fetch gives a string, not chunked. A small one as fetch
  // sends it.
  const large = (text) => text.repeat(Math.ceil((64 * 1024) / text.length));
  it.each([
    ["small", '{"x":1}', { "content-type": "application/json" }, "application/json"],
    ["large ASCII", large('{"x":1}'), { "content-type": "application/json" }, "application/json"],
    ["large multi-byte", JSON.stringify({ text: large("é日本😀") }), { "Content-Type": "application/json" }, "application/json"],
    ["large, no Content-Type", large("plain words "), {}, "text/plain;charset=UTF-8"],
    ["large, a Headers object", large('{"y":2}'), new Headers({ "content-type": "application/json", "content-length": "1" }), "application/json"],
    ["large, a Map of headers", large('{"z":3}'), new Map([["Content-Type", "application/json"]]), "application/json"],
  ])("sends a %s string body whole, with its length", async (_, body, headers, type) => {
    const res = await proxyAwareFetch(`${base}/wire`, { method: "POST", headers, body });
    expect(await res.json()).toEqual({ bytes: Buffer.byteLength(body), length: String(Buffer.byteLength(body)), chunked: false, type, sha: sha1(body) });
  });

  it("sends a request without a redirect once", async () => {
    hits.clear();
    const res = await post("/echo");
    expect(await res.json()).toEqual({ method: "POST", bytes: 7 });
    expect(hits.get("/echo")).toBe(1);
  });
});
