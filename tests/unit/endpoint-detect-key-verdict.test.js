// detectEndpoint's keyVerdict: what one run showed about the key it was given,
// so a caller trying several keys (the endpoint page's re-detect) can tell a
// refused or rate-limited key from a working one without piecing it together
// from authRejected / stopReason / failure. Fake upstreams only.
import { describe, it, expect } from "vitest";
import { detectEndpoint } from "@/lib/endpointDetect.js";

const KEY = "sk-test-0123456789abcdef";
const noSleep = async () => {};
const RECENT = new Date(Date.now() - 30 * 86400e3).toISOString().slice(0, 10);
const CATALOG = { providers: [], labs: Array.from({ length: 6 }, (_, i) => ({ id: `fam${i}-model-1`, lab: "x", family: `fam${i}`, date: RECENT })) };

// Scripted upstream: handler(method, pathname, body, headers) -> [status, body, headers?]
function upstream(handler) {
  return async (url, init) => {
    const u = new URL(url);
    const body = init.body ? JSON.parse(init.body) : null;
    const [status, out, headers = {}] = handler(init.method, u.pathname, body, init.headers || {}) || [404, "Not Found", { "content-type": "text/plain" }];
    return new Response(typeof out === "string" ? out : JSON.stringify(out), { status, headers: { "content-type": typeof out === "string" ? "text/plain" : "application/json", ...headers } });
  };
}
const oaiErr = (message, type = "invalid_request_error") => ({ error: { message, type } });
const detect = (fetchFn, over = {}) => detectEndpoint({ url: "https://api.acme.dev/v1", apiKey: KEY, fetchFn, catalog: CATALOG, sleep: noSleep, ...over });

// An OpenAI-style server with no /models: the protocol probe passes, then
// `model(id)` answers each model probe.
const chat = (model) => upstream((m, path, body) => {
  if (path !== "/v1/chat/completions") return;
  if (body.model === "probe") return [400, oaiErr("messages: at least one message is required")];
  return model(body.model);
});
const unknown = (id) => [404, oaiErr(`model ${id} not found`)];

describe("detectEndpoint keyVerdict", () => {
  it("accepted: models were found", async () => {
    const r = await detect(chat((id) => (id === "fam0-model-1" ? [400, oaiErr("messages: at least one message is required")] : unknown(id))));
    expect(r).toMatchObject({ ok: true, keyVerdict: "accepted", models: ["fam0-model-1"] });
  });

  it("refused: every request refuses the key", async () => {
    const r = await detect(upstream(() => [401, oaiErr("Invalid API key", "authentication_error")]));
    expect(r).toMatchObject({ ok: false, failure: "key", keyVerdict: "refused" });
  });

  it("refused: the free probes pass, then the model probes stop on the key", async () => {
    const r = await detect(chat(() => [403, { error: { message: "Forbidden", type: "forbidden" } }]));
    expect(r).toMatchObject({ ok: true, models: [], stopReason: "auth", keyVerdict: "refused" });
  });

  it("accepted: a key limited to models other than the ones asked about", async () => {
    const r = await detect(chat((id) => (id === "10router-no-such-model" ? unknown(id)
      : [403, oaiErr(`key not allowed to access model. This key can only access models=["other"]. Tried to access ${id}`, "auth_error")])));
    expect(r).toMatchObject({ ok: true, models: [], stopReason: "denied", authRejected: true, keyVerdict: "accepted" });
  });

  it("rate-limited: the model probes keep getting 429s and find nothing", async () => {
    const r = await detect(chat(() => [429, oaiErr("rate limited", "rate_limit_error")]));
    expect(r).toMatchObject({ ok: true, models: [], stopReason: "rate", keyVerdict: "rate-limited" });
  });

  it("rate-limited: the free probes are rate-limited", async () => {
    const r = await detect(upstream(() => [429, oaiErr("rate limited", "rate_limit_error")]));
    expect(r).toMatchObject({ ok: false, failure: "rate", keyVerdict: "rate-limited" });
  });

  it("accepted: only GET /models refused the key, and the model probes found nothing", async () => {
    // An admin-only list; chat answers alike with any key, so the bad-key check proves nothing.
    const r = await detect(upstream((m, path, body) => {
      if (path === "/v1/models") return [401, oaiErr("Admin key required", "authentication_error")];
      if (path !== "/v1/chat/completions") return;
      return body.model === "probe" ? [400, oaiErr("messages: at least one message is required")] : unknown(body.model);
    }));
    expect(r).toMatchObject({ ok: true, models: [], authRejected: true, keyVerdict: "accepted" });
  });

  it("accepted: the endpoint check, which asks no models", async () => {
    const r = await detect(chat(() => [401, oaiErr("Invalid API key", "authentication_error")]), { skipModels: true });
    expect(r).toMatchObject({ ok: true, keyVerdict: "accepted" });
  });

  it("accepted: a model was found before a later probe was rate-limited", async () => {
    const r = await detect(chat((id) => (id === "10router-no-such-model" ? unknown(id) : id === "fam0-model-1" ? [400, oaiErr("messages: at least one message is required")] : [429, oaiErr("rate limited", "rate_limit_error")])), { timeoutMs: 1000 });
    expect(r).toMatchObject({ ok: true, models: ["fam0-model-1"], stopReason: "rate", keyVerdict: "accepted" });
  });

  it("refused: one API's probes kept failing, then another API's stopped on the key", async () => {
    // Chat and Responses both answer the free probes. Chat's model probes keep
    // getting 5xx (that stop doesn't block the next API); Responses refuses the key.
    const r = await detect(upstream((m, path, body) => {
      if (path !== "/v1/chat/completions" && path !== "/v1/responses") return;
      if (body.model === "probe") return [400, oaiErr("input: required")];
      if (path === "/v1/chat/completions") return body.model === "10router-no-such-model" ? unknown(body.model) : [500, oaiErr("internal error", "server_error")];
      return [401, oaiErr("Invalid API key", "authentication_error")];
    }));
    expect(r.ok).toBe(true);
    expect(r.protocols).toEqual(expect.arrayContaining(["openai-chat", "openai-responses"]));
    expect(r.stopReason).toBe("failing");
    expect(r.keyVerdict).toBe("refused");
  });

  it("accepted: GET /models took the key (an empty list), even though the model probes are refused", async () => {
    const r = await detect(upstream((m, path, body, headers) => {
      if (path === "/v1/models") return headers.authorization ? [200, { object: "list", data: [] }] : [401, oaiErr("Missing key", "authentication_error")];
      if (path !== "/v1/chat/completions") return;
      return body.model === "probe" ? [400, oaiErr("messages: at least one message is required")] : [401, oaiErr("Invalid API key", "authentication_error")];
    }));
    expect(r).toMatchObject({ ok: true, models: [], keyVerdict: "accepted" });
  });

  it("accepted: an endpoint that answers every model id alike, so models can't be told apart", async () => {
    const r = await detect(chat(() => [400, oaiErr("messages: at least one message is required")]));
    expect(r).toMatchObject({ ok: true, models: [], keyVerdict: "accepted" });
  });

  it("nothing known: the model probes kept getting server errors", async () => {
    const r = await detect(chat((id) => (id === "10router-no-such-model" ? unknown(id) : [500, oaiErr("internal error", "server_error")])));
    expect(r).toMatchObject({ ok: true, models: [], stopReason: "failing", keyVerdict: null });
  });

  it("accepted: GET /models took the key, even when the model probes then fail", async () => {
    const r = await detect(upstream((m, path, body, headers) => {
      if (path === "/v1/models") return headers.authorization ? [200, { object: "list", data: [] }] : [401, oaiErr("Missing key", "authentication_error")];
      if (path !== "/v1/chat/completions") return;
      return body.model === "probe" ? [400, oaiErr("messages: at least one message is required")] : [503, oaiErr("upstream down", "server_error")];
    }));
    expect(r).toMatchObject({ ok: true, models: [], keyVerdict: "accepted" });
  });

  it("accepted: a key limited to other models on one API, though another API's probes kept failing", async () => {
    const r = await detect(upstream((m, path, body) => {
      if (path !== "/v1/chat/completions" && path !== "/v1/responses") return;
      if (body.model === "probe") return [400, oaiErr("input: required")];
      if (body.model === "10router-no-such-model") return unknown(body.model);
      if (path === "/v1/chat/completions") return [500, oaiErr("internal error", "server_error")];
      return [403, oaiErr(`key not allowed to access model. This key can only access models=["other"]. Tried to access ${body.model}`, "auth_error")];
    }));
    expect(r).toMatchObject({ ok: true, models: [], stopReason: "failing", keyVerdict: "accepted" });
  });

  it("nothing known: the made-up-id check got a server error", async () => {
    const r = await detect(chat(() => [503, oaiErr("upstream down", "server_error")]));
    expect(r).toMatchObject({ ok: true, models: [], keyVerdict: null });
  });

  it("nothing known: the model probes ran out of time before any answered", async () => {
    // The free probes answer at once; every model probe hangs past the deadline.
    const quick = chat((id) => (id === "10router-no-such-model" ? unknown(id) : null));
    const fetchFn = async (url, init) => {
      const body = init.body ? JSON.parse(init.body) : null;
      if (body?.model && body.model !== "probe" && body.model !== "10router-no-such-model") {
        await new Promise((resolve, reject) => {
          const t = setTimeout(resolve, 5_000);
          init.signal?.addEventListener("abort", () => { clearTimeout(t); reject(new DOMException("aborted", "AbortError")); });
        });
      }
      return quick(url, init);
    };
    const r = await detect(fetchFn, { deadlineMs: 300, timeoutMs: 5_000 });
    expect(r).toMatchObject({ ok: true, models: [], keyVerdict: null });
  });

  it("nothing known: only GET /models refused the key, and the API paths are down", async () => {
    const r = await detect(upstream((m, path) => (path === "/v1/models" ? [401, oaiErr("Admin key required", "authentication_error")] : [503, oaiErr("upstream down", "server_error")])));
    expect(r.ok).toBe(false);
    expect(r.keyVerdict).toBeNull();
  });

  it("nothing known about the key when the endpoint itself fails", async () => {
    const r = await detect(upstream(() => [503, oaiErr("upstream down", "server_error")]));
    expect(r.ok).toBe(false);
    expect(r.failure).not.toBe("key");
    expect(r.keyVerdict).toBeNull();
  });

  it("nothing known about the key when detection is cancelled", async () => {
    const ctl = new AbortController();
    ctl.abort();
    const r = await detect(upstream(() => [400, oaiErr("messages empty")]), { signal: ctl.signal });
    expect(r).toMatchObject({ ok: false, failure: "cancelled", keyVerdict: null });
  });
});
