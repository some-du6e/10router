// Recent requests on a custom endpoint's page (src/lib/endpointRequestLog.ts):
// captured at the engine's fetch (open-sse/utils/proxyFetch.js) around a routed request.
import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  recordEndpointRequests, getEndpointRequests, clearEndpointRequests, pushEndpointRequest,
  maskKey, lastPrompt, outputTokens, replyText, errorMessage, MAX_PER_ENDPOINT,
} from "../../src/lib/endpointRequestLog.ts";
import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";
import { pickTestModel } from "../../src/app/api/providers/[id]/requests/pick.ts";

const KEY = "pat-ZXlKcmFXUWlPaUl4TWpNME5UWTNPRGt3SW4w7f2a";
const EP = "anthropic-compatible-test-log";
let server, base;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (String(req.headers["anthropic-beta"] || "").includes("oauth-2025-04-20")) {
        res.statusCode = 400;
        return res.end(JSON.stringify({ message: "Unexpected value(s) `oauth-2025-04-20` for the `anthropic-beta` header. Please consult our documentation." }));
      }
      res.end(JSON.stringify({ type: "message", content: [{ type: "text", text: "Hi" }], usage: { input_tokens: 8, output_tokens: 1 }, echo: KEY }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}/v1`;
});
afterAll(() => server?.close());

const post = (beta) => proxyAwareFetch(`${base}/messages`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-api-key": KEY, authorization: `Bearer ${KEY}`, ...(beta ? { "anthropic-beta": beta } : {}) },
  body: JSON.stringify({ model: "claude-haiku-4-5", max_tokens: 1, messages: [{ role: "user", content: "hi" }] }),
}).then((r) => r.text());

const creds = { apiKey: KEY, providerSpecificData: { baseUrl: "" } };

describe("endpoint request log", () => {
  it("records requests to a custom endpoint, key masked, with a drop-and-retry fix row", async () => {
    clearEndpointRequests(EP);
    await recordEndpointRequests(EP, { ...creds, providerSpecificData: { baseUrl: base } }, async () => {
      await post("oauth-2025-04-20,interleaved-thinking-2025-05-14");
      await post("interleaved-thinking-2025-05-14");
    });
    // The response clone is read after the caller's; give it a tick.
    await new Promise((r) => setTimeout(r, 20));
    const log = getEndpointRequests(EP);
    expect(log.map((l) => l.kind)).toEqual(["request", "fix", "request"]);
    const [bad, fix, good] = log;
    expect(bad).toMatchObject({ ok: false, status: 400, model: "claude-haiku-4-5", prompt: "hi" });
    expect(bad.error).toMatch(/Unexpected value/);
    expect(fix.flags).toEqual(["oauth-2025-04-20"]);
    expect(good).toMatchObject({ ok: true, status: 200, note: "200 · 1 token", reply: "Hi" });
    for (const l of log) {
      expect(JSON.stringify(l)).not.toContain(KEY);
    }
    expect(good.request).toContain(`x-api-key: ${maskKey(KEY)}`);
    expect(good.request).toContain(`Bearer ${maskKey(KEY)}`);
    expect(good.request).toMatch(/^POST http:\/\/127\.0\.0\.1:\d+\/v1\/messages/);
    expect(good.response).toMatch(/^HTTP 200/);
  });

  it("ignores requests to other hosts and built-in providers", async () => {
    clearEndpointRequests(EP);
    await recordEndpointRequests(EP, { ...creds, providerSpecificData: { baseUrl: "https://elsewhere.example/v1" } }, () => post(""));
    await recordEndpointRequests("anthropic", creds, () => post(""));
    await post("");
    await new Promise((r) => setTimeout(r, 20));
    expect(getEndpointRequests(EP)).toEqual([]);
    expect(getEndpointRequests("anthropic")).toEqual([]);
  });

  it("keeps only the last MAX_PER_ENDPOINT", () => {
    clearEndpointRequests(EP);
    for (let i = 0; i < MAX_PER_ENDPOINT + 5; i++) pushEndpointRequest(EP, { id: String(i) });
    const log = getEndpointRequests(EP);
    expect(log).toHaveLength(MAX_PER_ENDPOINT);
    expect(log[0].id).toBe("5");
  });
});

describe("helpers", () => {
  it("masks keys like the key list does", () => {
    expect(maskKey(KEY)).toBe("pat-…7f2a");
    expect(maskKey("short")).toBe("key…");
    expect(maskKey("sk-abcdefgh")).toBe("sk-…");
  });
  it("reads the prompt, reply, tokens and error", () => {
    expect(lastPrompt({ messages: [{ role: "user", content: [{ type: "text", text: "  hello\nthere " }] }] })).toBe("hello there");
    expect(lastPrompt({ input: "hi" })).toBe("hi");
    const sse = 'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\ndata: {"choices":[{"delta":{"content":" there"}}],"usage":{"completion_tokens":2}}\n\ndata: [DONE]\n';
    expect(replyText(sse)).toBe("Hi there");
    expect(outputTokens(sse)).toBe(2);
    expect(replyText(JSON.stringify({ choices: [{ message: { content: "Hey" } }] }))).toBe("Hey");
    expect(errorMessage(JSON.stringify({ error: { message: "model not found" } }))).toBe("model not found");
  });
  it("picks a small model for the test message", () => {
    expect(pickTestModel(["claude-opus-4-6", "claude-haiku-4-5"])).toBe("claude-haiku-4-5");
    expect(pickTestModel(["deepseek-v4-pro"])).toBe("deepseek-v4-pro");
    expect(pickTestModel([])).toBeNull();
  });
});
