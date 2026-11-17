// The real wiring proxyFetch relies on, on the Node this runs on: the runtime's
// fetch honours the headersTimeout of an npm-undici Agent passed as its
// dispatcher (the runtime may bundle another undici), and its headers timeout
// error is the shape isUndiciHeadersTimeout knows. A real server on 127.0.0.1.
import http from "node:http";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Agent } from "undici";

const { isUndiciHeadersTimeout } = await import("../../open-sse/utils/headersTimeout.js");

let server;
let base;
const agents = [];

beforeAll(async () => {
  // /slow sends its headers after 300ms; /never doesn't send any.
  server = http.createServer((req, res) => {
    if (req.url === "/slow") setTimeout(() => res.end("ok"), 300);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await Promise.all(agents.map((agent) => agent.destroy().catch(() => {})));
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
});

const agent = (options) => {
  const a = new Agent(options);
  agents.push(a);
  return a;
};

describe("undici's headers timeout with the runtime's fetch", () => {
  it("waits for headers when an Agent turns it off", async () => {
    const res = await fetch(`${base}/slow`, { dispatcher: agent({ headersTimeout: 0 }) });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  // undici's timers tick about once a second, so a 50ms limit ends the fetch within ~1s.
  it("ends the fetch with UND_ERR_HEADERS_TIMEOUT, which isUndiciHeadersTimeout knows", async () => {
    const error = await fetch(`${base}/never`, { dispatcher: agent({ headersTimeout: 50 }) }).catch((e) => e);
    expect(error.cause?.code).toBe("UND_ERR_HEADERS_TIMEOUT");
    expect(isUndiciHeadersTimeout(error)).toBe(true);
  }, 5000);
});
