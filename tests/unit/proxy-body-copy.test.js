// Next hands the proxy (src/proxy.js) its own copy of each request body,
// pushed the same chunks as the route's, and the request keeps that copy
// reachable until its response ends. The proxy reads its copy as it arrives
// (src/lib/proxyBodyCopy.js), so a request whose route has parsed the body no
// longer holds it a second time, raw, while it waits or streams.
//
// Runs Next's own pieces on a real HTTP server, as `next start` does for a
// Node proxy: getCloneableBody, the proxy adapter, finalize(), then the
// route's Request built on the IncomingMessage.
import "next/dist/server/node-environment.js";
import http from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getCloneableBody } from "next/dist/server/body-streams.js";
import { adapter } from "next/dist/server/web/adapter.js";
import { NextResponse } from "next/server";
import { gc } from "../helpers/heldStreams.js";

vi.mock("../../src/dashboardGuard.js", () => ({ proxy: async () => NextResponse.next() }));

const { default: proxy } = await import("../../src/proxy.js");

const SIZE = 3 * 1024 * 1024;
let server;

afterEach(async () => {
  await new Promise((resolve) => (server ? server.close(resolve) : resolve()));
  server = null;
});

// A server that runs the proxy the way next-server's runMiddleware does, then
// hands the request to `route` with the body as the route reads it. `seen`
// gets when the proxy returned and how finalize() ended.
function serve(route, { chunks = null, seen = {} } = {}) {
  server = http.createServer(async (req, res) => {
    if (chunks) req.on("data", (chunk) => chunks.push(new WeakRef(chunk)));
    const clonable = getCloneableBody(req);
    const hasBody = req.method !== "GET";
    let proxied;
    try {
      try {
        proxied = await adapter({
          handler: proxy,
          page: "/proxy",
          request: {
            headers: req.headers,
            method: req.method,
            url: `http://localhost${req.url}`,
            nextConfig: {},
            body: hasBody ? clonable.cloneBodyStream() : undefined,
            signal: new AbortController().signal,
          },
        });
        seen.proxiedAt = Date.now();
      } finally {
        if (hasBody) await clonable.finalize();
      }
    } catch (error) {
      seen.error = error;
      res.destroy();
      return;
    }
    route({ req, res, proxied, body: () => new Request(`http://localhost${req.url}`, { method: req.method, body: req, duplex: "half" }) });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

function send(port, { method = "POST", payload = null, path = "/v1/messages" } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ port, method, path, headers: payload ? { "content-type": "application/json", "content-length": payload.length } : {} }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode));
    });
    req.on("error", reject);
    req.end(payload);
  });
}

async function fullGc() {
  for (let i = 0; i < 4; i++) {
    gc();
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const payloadOf = (n) => Buffer.from(JSON.stringify({ model: "m", messages: [{ role: "user", content: "x".repeat(n) }] }));

describe("the proxy's copy of a request body", () => {
  it("is collectable once the route has read the body, while the request is still open", async () => {
    const chunks = [];
    let release;
    const read = new Promise((resolve) => {
      release = resolve;
    });
    const open = [];
    const port = await serve(async ({ req, res, body }) => {
      const text = await body().text();
      open.push({ req, res, length: text.length });
      release();
    }, { chunks });
    const payload = payloadOf(SIZE);
    const done = send(port, { payload });
    await read;
    await fullGc();
    expect(open[0].length).toBe(payload.length);
    expect(chunks.length).toBeGreaterThan(1);
    // The request and its response are still open, as for one waiting or streaming.
    const kept = chunks.filter((ref) => ref.deref() !== undefined).length;
    expect(kept).toBe(0);
    open[0].res.end("ok");
    expect(await done).toBe(200);
  });

  it("leaves the route the whole body, byte for byte", async () => {
    let got;
    const port = await serve(async ({ res, body }) => {
      got = Buffer.from(await body().arrayBuffer());
      res.end("ok");
    });
    const payload = Buffer.concat([payloadOf(512 * 1024), Buffer.from(" ✓ ─", "utf8")]);
    expect(await send(port, { payload })).toBe(200);
    expect(got.equals(payload)).toBe(true);
  });

  it("returns before the upload ends, and doesn't wait on one that is cut off", async () => {
    const seen = {};
    let routed = false;
    const port = await serve(({ res }) => {
      routed = true;
      res.end("ok");
    }, { seen });
    const started = Date.now();
    const req = http.request({ port, method: "POST", path: "/v1/messages", headers: { "content-type": "application/json", "content-length": 10 * SIZE } });
    req.on("error", () => {});
    req.write(Buffer.alloc(256 * 1024, 120));
    await vi.waitFor(() => expect(seen.proxiedAt).toBeTypeOf("number"), { timeout: 3000 });
    req.destroy();
    // finalize() waits for the body and fails on the cut-off upload, so the route never runs.
    await vi.waitFor(() => expect(seen.error).toBeDefined(), { timeout: 3000 });
    expect(seen.proxiedAt - started).toBeLessThan(3000);
    expect(routed).toBe(false);
  });

  it("is left alone on a request without a body", async () => {
    const port = await serve(({ res, proxied }) => res.end(proxied ? "ok" : "no"));
    expect(await send(port, { method: "GET", path: "/dashboard" })).toBe(200);
  });
});
