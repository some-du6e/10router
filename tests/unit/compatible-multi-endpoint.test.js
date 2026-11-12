import { describe, it, expect, vi, beforeEach } from "vitest";

// One compatible provider, several endpoints: each key may carry its own base
// URL (providerSpecificData.baseUrl + ownBaseUrl), and key failover then fails
// over between endpoints.

const db = vi.hoisted(() => ({ nodes: [], connections: [], customModels: [], local: true }));
const mocks = vi.hoisted(() => ({
  json: vi.fn((body, init) => ({ status: init?.status || 200, body })),
  upstream: vi.fn(),
  probeFetch: vi.fn(),
  makeProbeFetch: vi.fn(),
}));

vi.mock("@/lib/probeFetch.js", () => ({ makeProbeFetch: mocks.makeProbeFetch }));

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  default: mocks.upstream,
  proxyAwareFetch: mocks.upstream,
}));

vi.mock("next/server", () => ({ NextResponse: { json: mocks.json } }));
vi.mock("@/dashboardGuard", () => ({ isLocalRequest: () => db.local }));

vi.mock("@/models", () => ({
  getProviderNodes: vi.fn(async () => db.nodes),
  getCustomModels: vi.fn(async () => db.customModels),
  getProviderNodeById: vi.fn(async (id) => db.nodes.find((n) => n.id === id) || null),
  updateProviderNode: vi.fn(async (id, data) => {
    const i = db.nodes.findIndex((n) => n.id === id);
    db.nodes[i] = { ...db.nodes[i], ...data };
    return db.nodes[i];
  }),
  getProviderConnections: vi.fn(async ({ provider }) => db.connections.filter((c) => c.provider === provider)),
  getProviderConnectionById: vi.fn(async (id) => db.connections.find((c) => c.id === id) || null),
  createProviderConnection: vi.fn(async (c) => {
    const conn = { id: `conn-${db.connections.length + 1}`, ...c };
    db.connections.push(conn);
    return conn;
  }),
  updateProviderConnection: vi.fn(async (id, data) => {
    const c = db.connections.find((x) => x.id === id);
    Object.assign(c, data);
    return c;
  }),
  getProxyPoolById: vi.fn(async () => null),
  deleteProviderConnection: vi.fn(),
  deleteProviderConnectionsByProvider: vi.fn(),
  deleteProviderNode: vi.fn(),
}));

const providersRoute = await import("../../src/app/api/providers/route.js");
const connectionRoute = await import("../../src/app/api/providers/[id]/route.js");
const nodeRoute = await import("../../src/app/api/provider-nodes/[id]/route.js");
const validateRoute = await import("../../src/app/api/providers/validate/route.js");
const { getExecutor } = await import("../../open-sse/executors/index.js");
const { normalizeEndpointUrl } = await import("../../src/shared/utils/connectionBaseUrl.js");

const NODE_ID = "openai-compatible-chat-snow";
const URL_A = "https://accta.snowflakecomputing.com/api/v2/cortex/v1";
const URL_B = "https://acctb.snowflakecomputing.com/api/v2/cortex/v1";

const req = (body) => ({ json: async () => body, headers: new Headers() });
const params = (id) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  mocks.probeFetch.mockReset();
  mocks.makeProbeFetch.mockReset().mockReturnValue(mocks.probeFetch);
  db.local = true;
  db.connections = [];
  db.customModels = [];
  db.nodes = [{ id: NODE_ID, type: "openai-compatible", prefix: "snow", apiType: "chat", baseUrl: URL_A, name: "Snowflake", stripBeta: false }];
});

describe("per-key endpoint URL", () => {
  it("normalizes pasted URLs like the node routes", () => {
    expect(normalizeEndpointUrl(` ${URL_B}/chat/completions/ `)).toBe(URL_B);
    expect(normalizeEndpointUrl("https://x.example/v1/messages")).toBe("https://x.example/v1");
    expect(normalizeEndpointUrl("https://x.example/openai/responses?api-version=1")).toBe("https://x.example/openai?api-version=1");
  });

  it("stores a key's own base URL with the flag", async () => {
    const res = await providersRoute.POST(req({ provider: NODE_ID, apiKey: "sk-b", name: "B", baseUrl: `${URL_B}/chat/completions` }));
    expect(res.status).toBe(201);
    expect(db.connections[0].providerSpecificData).toMatchObject({ baseUrl: URL_B, ownBaseUrl: true, prefix: "snow" });
  });

  it("the node's own URL, or none, is not an override", async () => {
    await providersRoute.POST(req({ provider: NODE_ID, apiKey: "sk-a", name: "A", baseUrl: `${URL_A}/` }));
    await providersRoute.POST(req({ provider: NODE_ID, apiKey: "sk-c", name: "C" }));
    for (const c of db.connections) {
      expect(c.providerSpecificData.baseUrl).toBe(URL_A);
      expect(c.providerSpecificData.ownBaseUrl).toBeUndefined();
    }
  });

  it("rejects an internal URL from a remote caller", async () => {
    db.local = false;
    const res = await providersRoute.POST(req({ provider: NODE_ID, apiKey: "sk-b", name: "B", baseUrl: "http://169.254.169.254/latest" }));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("URL not allowed");
    expect(db.connections).toHaveLength(0);

    await providersRoute.POST(req({ provider: NODE_ID, apiKey: "sk-a", name: "A" }));
    const put = await connectionRoute.PUT(req({ baseUrl: "http://127.0.0.1:8080/v1" }), params("conn-1"));
    expect(put.status).toBe(400);
    expect(db.connections[0].providerSpecificData.baseUrl).toBe(URL_A);
  });

  it("providerSpecificData can't set the key's URL", async () => {
    db.local = false;
    await providersRoute.POST(req({ provider: NODE_ID, apiKey: "sk-a", name: "A", providerSpecificData: { baseUrl: "http://169.254.169.254/latest", ownBaseUrl: true } }));
    expect(db.connections[0].providerSpecificData.baseUrl).toBe(URL_A);
    expect(db.connections[0].providerSpecificData.ownBaseUrl).toBeUndefined();

    const put = await connectionRoute.PUT(req({ providerSpecificData: { baseUrl: "http://169.254.169.254/latest", ownBaseUrl: true, region: "eu" } }), params("conn-1"));
    expect(put.status).toBe(200);
    expect(db.connections[0].providerSpecificData).toMatchObject({ baseUrl: URL_A, prefix: "snow", region: "eu" });
    expect(db.connections[0].providerSpecificData.ownBaseUrl).toBeUndefined();
  });

  it("providerSpecificData can't clear a key's own URL flag either", async () => {
    await providersRoute.POST(req({ provider: NODE_ID, apiKey: "sk-b", name: "B", baseUrl: URL_B }));
    await connectionRoute.PUT(req({ providerSpecificData: { baseUrl: "http://127.0.0.1/v1" } }), params("conn-1"));
    expect(db.connections[0].providerSpecificData).toMatchObject({ baseUrl: URL_B, ownBaseUrl: true });
  });

  it("rejects a non-http URL", async () => {
    const res = await providersRoute.POST(req({ provider: NODE_ID, apiKey: "sk-b", name: "B", baseUrl: "file:///etc/passwd" }));
    expect(res.status).toBe(400);
  });

  it("node edits keep a key's own URL but still update quirks", async () => {
    await providersRoute.POST(req({ provider: NODE_ID, apiKey: "sk-a", name: "A" }));
    await providersRoute.POST(req({ provider: NODE_ID, apiKey: "sk-b", name: "B", baseUrl: URL_B }));
    const NEW_A = "https://accta-new.snowflakecomputing.com/api/v2/cortex/v1";
    const res = await nodeRoute.PUT(req({ name: "Snowflake", prefix: "snow", apiType: "chat", baseUrl: NEW_A, quirks: { stripBeta: true } }), params(NODE_ID));
    expect(res.status).toBe(200);
    const [a, b] = db.connections;
    expect(a.providerSpecificData).toMatchObject({ baseUrl: NEW_A, stripBeta: true });
    expect(b.providerSpecificData).toMatchObject({ baseUrl: URL_B, ownBaseUrl: true, stripBeta: true });
  });

  it("edits and clears a key's URL", async () => {
    await providersRoute.POST(req({ provider: NODE_ID, apiKey: "sk-a", name: "A" }));
    let res = await connectionRoute.PUT(req({ baseUrl: URL_B }), params("conn-1"));
    expect(res.status).toBe(200);
    expect(db.connections[0].providerSpecificData).toMatchObject({ baseUrl: URL_B, ownBaseUrl: true });

    res = await connectionRoute.PUT(req({ baseUrl: null }), params("conn-1"));
    expect(res.status).toBe(200);
    expect(db.connections[0].providerSpecificData.baseUrl).toBe(URL_A);
    expect(db.connections[0].providerSpecificData.ownBaseUrl).toBeUndefined();
    expect(db.connections[0].providerSpecificData.prefix).toBe("snow");
  });

  it("other edits leave the URL alone", async () => {
    await providersRoute.POST(req({ provider: NODE_ID, apiKey: "sk-b", name: "B", baseUrl: URL_B }));
    await connectionRoute.PUT(req({ name: "Renamed" }), params("conn-1"));
    expect(db.connections[0].providerSpecificData).toMatchObject({ baseUrl: URL_B, ownBaseUrl: true });
  });
});

describe("failover across endpoints", () => {
  it("a 429 on the first key's endpoint moves to the second key's endpoint", async () => {
    const executor = getExecutor(NODE_ID);
    const hits = [];
    mocks.upstream.mockImplementation(async (url) => {
      hits.push(String(url));
      return String(url).startsWith(URL_A)
        ? new Response(JSON.stringify({ error: { message: "rate limited" } }), { status: 429, headers: { "content-type": "application/json" } })
        : new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }] }), { status: 200, headers: { "content-type": "application/json" } });
    });

    // The account loop in src/sse/handlers/chat: try a key, and on a fallback
    // error move to the next key, whose credentials carry its own baseUrl.
    const keys = [
      { connectionId: "a", apiKey: "sk-a", providerSpecificData: { baseUrl: URL_A } },
      { connectionId: "b", apiKey: "sk-b", providerSpecificData: { baseUrl: URL_B, ownBaseUrl: true } },
    ];
    let last;
    for (const credentials of keys) {
      last = await executor.execute({ model: "claude-sonnet-4-5", body: { model: "claude-sonnet-4-5", messages: [{ role: "user", content: "hi" }] }, stream: false, credentials, log: null });
      if (last.response.status !== 429) break;
    }

    expect(hits[0]).toBe(`${URL_A}/chat/completions`);
    expect(hits.at(-1)).toBe(`${URL_B}/chat/completions`);
    expect(last.response.status).toBe(200);
  });
});

describe("validating a key at its own URL", () => {
  // A literal public IP: the SSRF check needs no DNS.
  const PUBLIC_URL = "https://8.8.8.8/v1";
  const okRes = () => ({ ok: true, status: 200, json: async () => ({}), text: async () => "" });

  it("a remote caller's own URL goes through the pinned probe fetch", async () => {
    db.local = false;
    mocks.probeFetch.mockResolvedValue(okRes());
    const res = await validateRoute.POST(req({ provider: NODE_ID, apiKey: "sk-b", baseUrl: PUBLIC_URL }));
    expect(res.body.valid).toBe(true);
    expect(mocks.makeProbeFetch).toHaveBeenCalledWith(true);
    expect(mocks.probeFetch).toHaveBeenCalledWith(`${PUBLIC_URL}/models`, expect.objectContaining({ headers: { Authorization: "Bearer sk-b" } }));
  });

  it("an anthropic-compatible key does too", async () => {
    db.local = false;
    db.nodes.push({ id: "anthropic-compatible-x", type: "anthropic-compatible", prefix: "ax", baseUrl: "https://api.example.com", name: "X" });
    mocks.probeFetch.mockResolvedValue({ ...okRes(), ok: false, status: 400 });
    const res = await validateRoute.POST(req({ provider: "anthropic-compatible-x", apiKey: "sk-x", baseUrl: PUBLIC_URL }));
    expect(res.body.valid).toBe(true);
    expect(mocks.probeFetch).toHaveBeenCalledWith(`${PUBLIC_URL}/messages`, expect.objectContaining({ method: "POST" }));
  });

  it("probes an anthropic-compatible key at the URL routing posts to, with or without /v1 and a query", async () => {
    db.local = false;
    const id = "anthropic-compatible-shapes";
    db.nodes.push({ id, type: "anthropic-compatible", prefix: "as", baseUrl: "https://api.example.com/v1", name: "Shapes" });
    mocks.probeFetch.mockResolvedValue(okRes());
    const origin = PUBLIC_URL.replace(/\/v1$/, "");
    for (const [base, probed] of [
      [PUBLIC_URL, `${PUBLIC_URL}/messages`],
      [`${PUBLIC_URL}?k=1`, `${PUBLIC_URL}/messages?k=1`],
      [origin, `${origin}/messages`],
      [`${origin}?k=1`, `${origin}/messages?k=1`],
    ]) {
      await validateRoute.POST(req({ provider: id, apiKey: "sk-s", baseUrl: base }));
      expect(mocks.probeFetch, base).toHaveBeenLastCalledWith(probed, expect.objectContaining({ method: "POST" }));
      // The same URL a request on that key goes to.
      expect(getExecutor(id).buildUrl("m", false, 0, { providerSpecificData: { baseUrl: base } }), base).toBe(probed);
    }
    // A key on the endpoint's own URL (stored with its /v1) is probed there too.
    db.local = true;
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(okRes());
    try {
      await validateRoute.POST(req({ provider: id, apiKey: "sk-s" }));
      expect(spy).toHaveBeenCalledWith("https://api.example.com/v1/messages", expect.objectContaining({ method: "POST" }));
    } finally {
      spy.mockRestore();
    }
  });

  it("probes the API path before a query string in the key's URL, like routing", async () => {
    db.local = false;
    db.nodes.push({ id: "anthropic-compatible-q", type: "anthropic-compatible", prefix: "aq", baseUrl: "https://api.example.com", name: "Q" });
    mocks.probeFetch.mockResolvedValue(okRes());
    await validateRoute.POST(req({ provider: NODE_ID, apiKey: "sk-q", baseUrl: `${PUBLIC_URL}?token=t1` }));
    expect(mocks.probeFetch).toHaveBeenLastCalledWith(`${PUBLIC_URL}/models?token=t1`, expect.anything());
    await validateRoute.POST(req({ provider: "anthropic-compatible-q", apiKey: "sk-q", baseUrl: `${PUBLIC_URL}/messages?token=t2` }));
    expect(mocks.probeFetch).toHaveBeenLastCalledWith(`${PUBLIC_URL}/messages?token=t2`, expect.anything());
  });

  // A gateway that limits each key to some models answers any other one with a 403.
  const modelGateway = (allowed) => async (_url, init) => {
    const { model } = JSON.parse(init.body);
    return { ...okRes(), ok: allowed.includes(model), status: allowed.includes(model) ? 200 : 403 };
  };

  it("probes an anthropic-compatible key with a model the endpoint lists, not a stock one", async () => {
    db.local = false;
    const id = "anthropic-compatible-models";
    db.nodes.push({ id, type: "anthropic-compatible", prefix: "am", baseUrl: "https://api.example.com/v1", name: "Models" });
    // Decoys that look small, so dropping the endpoint or llm-only filter picks them.
    db.customModels = [
      { providerAlias: "anthropic-compatible-other", id: "other-mini", type: "llm" },
      { providerAlias: id, id: "acme-embed-small", type: "embedding" },
      { providerAlias: id, id: "acme-opus", type: "llm" },
      { providerAlias: id, id: "acme-haiku", type: "llm" },
    ];
    mocks.probeFetch.mockImplementation(modelGateway(["acme-opus", "acme-haiku"]));
    const res = await validateRoute.POST(req({ provider: id, apiKey: "sk-m", baseUrl: PUBLIC_URL }));
    expect(res.body.valid).toBe(true);
    // A small listed model, as "Send test message" picks.
    expect(JSON.parse(mocks.probeFetch.mock.calls.at(-1)[1].body).model).toBe("acme-haiku");

    // The key's own default model comes first.
    mocks.probeFetch.mockImplementation(modelGateway(["acme-opus"]));
    const own = await validateRoute.POST(req({ provider: id, apiKey: "sk-m", baseUrl: PUBLIC_URL, defaultModel: "acme-opus" }));
    expect(own.body.valid).toBe(true);
    expect(JSON.parse(mocks.probeFetch.mock.calls.at(-1)[1].body).model).toBe("acme-opus");

    // With no models listed, the stock fallback.
    db.customModels = [];
    await validateRoute.POST(req({ provider: id, apiKey: "sk-m", baseUrl: PUBLIC_URL }));
    expect(JSON.parse(mocks.probeFetch.mock.calls.at(-1)[1].body).model).toBe("claude-3-haiku-20240307");
  });

  it("probes with the endpoint's path and query overrides and model renames, as routing sends them", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(okRes());
    try {
      db.nodes.push(
        { id: "anthropic-compatible-path", type: "anthropic-compatible", prefix: "ap", baseUrl: "https://api.example.com", name: "Path", overrides: { path: "/v1/messages" } },
        { id: "anthropic-compatible-query", type: "anthropic-compatible", prefix: "aq2", baseUrl: "https://api.example.com/v1", name: "Query", overrides: { query: "api-version=2", models: "acme-haiku => upstream-haiku" } },
        { id: "openai-compatible-chat-query", type: "openai-compatible", prefix: "oq", apiType: "chat", baseUrl: "https://api.example.com/v1", name: "OQ", overrides: { query: "api-version=2", path: "/v2/chat" } },
      );
      db.customModels = [{ providerAlias: "anthropic-compatible-query", id: "acme-haiku", type: "llm" }];
      await validateRoute.POST(req({ provider: "anthropic-compatible-path", apiKey: "sk-p" }));
      expect(spy).toHaveBeenLastCalledWith("https://api.example.com/v1/messages", expect.objectContaining({ method: "POST" }));
      await validateRoute.POST(req({ provider: "anthropic-compatible-query", apiKey: "sk-p" }));
      expect(spy).toHaveBeenLastCalledWith("https://api.example.com/v1/messages?api-version=2", expect.objectContaining({ method: "POST" }));
      expect(JSON.parse(spy.mock.calls.at(-1)[1].body).model).toBe("upstream-haiku");
      // /models takes the query override; the path override is for the chat path.
      await validateRoute.POST(req({ provider: "openai-compatible-chat-query", apiKey: "sk-p" }));
      expect(spy).toHaveBeenLastCalledWith("https://api.example.com/v1/models?api-version=2", expect.anything());
    } finally {
      spy.mockRestore();
    }
  });

  it("probes with the headers routing sends: the node's auth header style and header lines, and only the probed key", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(okRes());
    try {
      db.nodes.push(
        { id: "openai-compatible-chat-azure", type: "openai-compatible", prefix: "az", apiType: "chat", baseUrl: "https://api.example.com/openai", name: "AZ", apiKeyHeader: "api-key" },
        { id: "anthropic-compatible-hdr", type: "anthropic-compatible", prefix: "ah", baseUrl: "https://api.example.com/v1", name: "HDR", overrides: { headers: "x-acme-team: blue" } },
      );
      // Another key on the same endpoint, which must never ride along.
      db.connections.push({ id: "other", provider: "anthropic-compatible-hdr", apiKey: "sk-other-key", providerSpecificData: { baseUrl: "https://api.example.com/v1" } });

      await validateRoute.POST(req({ provider: "openai-compatible-chat-azure", apiKey: "sk-az" }));
      const [modelsUrl, modelsInit] = spy.mock.calls.at(-1);
      expect(modelsUrl).toBe("https://api.example.com/openai/models");
      expect(modelsInit.headers).toEqual({ "api-key": "sk-az" });

      await validateRoute.POST(req({ provider: "anthropic-compatible-hdr", apiKey: "sk-probed" }));
      const [, init] = spy.mock.calls.at(-1);
      expect(init.headers["x-acme-team"]).toBe("blue");
      expect(init.headers["x-api-key"]).toBe("sk-probed");
      const sent = JSON.stringify(init);
      expect(sent).not.toContain("sk-other-key");
      // Every header carrying a key carries the probed one.
      for (const [name, value] of Object.entries(init.headers)) {
        if (/sk-/.test(value)) expect(value, name).toMatch(/^(Bearer )?sk-probed$/);
      }
    } finally {
      spy.mockRestore();
    }
  });

  it("follows the node's model routes, prefers a model on the probe's own path, and drops a thinking suffix", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(okRes());
    try {
      const id = "anthropic-compatible-routes";
      db.nodes.push({ id, type: "anthropic-compatible", prefix: "ar", baseUrl: "https://api.example.com/v1", name: "Routes", modelRoutes: { "acme-gpt": "openai-chat", "acme-resp": "openai-responses" } });
      db.customModels = [
        { providerAlias: id, id: "acme-gpt", type: "llm" },
        { providerAlias: id, id: "acme-sonnet", type: "llm" },
      ];
      // A listed model the node sends elsewhere is passed over for one on /messages.
      await validateRoute.POST(req({ provider: id, apiKey: "sk-r" }));
      expect(spy.mock.calls.at(-1)[0]).toBe("https://api.example.com/v1/messages");
      expect(JSON.parse(spy.mock.calls.at(-1)[1].body).model).toBe("acme-sonnet");

      // A default model routed to Chat Completions is probed there, "(high)" dropped as routing does.
      await validateRoute.POST(req({ provider: id, apiKey: "sk-r", defaultModel: "acme-gpt(high)" }));
      const [chatUrl, chatInit] = spy.mock.calls.at(-1);
      expect(chatUrl).toBe("https://api.example.com/v1/chat/completions");
      expect(JSON.parse(chatInit.body).model).toBe("acme-gpt");
      expect(chatInit.headers.Authorization).toBe("Bearer sk-r");

      // And one routed to the Responses API gets a Responses body.
      await validateRoute.POST(req({ provider: id, apiKey: "sk-r", defaultModel: "acme-resp" }));
      const [respUrl, respInit] = spy.mock.calls.at(-1);
      expect(respUrl).toBe("https://api.example.com/v1/responses");
      expect(JSON.parse(respInit.body)).toMatchObject({ model: "acme-resp", input: "test" });

      // Only routed models listed: one of them, at its route.
      db.customModels = [{ providerAlias: id, id: "acme-gpt", type: "llm" }];
      await validateRoute.POST(req({ provider: id, apiKey: "sk-r" }));
      expect(spy.mock.calls.at(-1)[0]).toBe("https://api.example.com/v1/chat/completions");
    } finally {
      spy.mockRestore();
    }
  });

  describe("an OpenAI-compatible upstream without a /models route", () => {
    const answer = (status, body = { code: "x", message: "m" }) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    // /models answers `modelsStatus`; the chat path answers `chatStatus`.
    const upstream = (modelsStatus, chatStatus) => {
      const sent = [];
      mocks.probeFetch.mockImplementation(async (url, init) => {
        const res = answer(String(url).includes("/models") ? modelsStatus : chatStatus);
        sent.push({ url, init, res });
        return res;
      });
      return sent;
    };
    const validate = (body) => validateRoute.POST(req({ provider: NODE_ID, apiKey: "sk-b", baseUrl: PUBLIC_URL, ...body }));
    beforeEach(() => { db.local = false; });

    it("a key the chat path refuses only for the missing model is valid", async () => {
      const sent = upstream(404, 400);
      const res = await validate();
      expect(res.body).toEqual({ valid: true, error: null });
      expect(sent).toHaveLength(2);
      // At the key's own URL, through the pinned probe fetch, with no model: nothing to run.
      const [, chat] = sent;
      expect(chat.url).toBe(`${PUBLIC_URL}/chat/completions`);
      expect(chat.init).toMatchObject({ method: "POST", body: "{}" });
      expect(chat.init.headers).toMatchObject({ Authorization: "Bearer sk-b", "Content-Type": "application/json" });
      // Both bodies are dropped, so the pinned connections close.
      for (const { res: r } of sent) expect(r.bodyUsed).toBe(true);
    });

    it("a key the chat path answers with 401 or 403 is invalid", async () => {
      for (const status of [401, 403]) {
        upstream(404, status);
        const res = await validate();
        expect(res.body, String(status)).toEqual({ valid: false, error: "Invalid API key" });
      }
    });

    it("a key the chat path answers with 2xx or a body refusal (400, 422) is valid", async () => {
      for (const status of [200, 201, 400, 422]) {
        upstream(404, status);
        expect((await validate()).body, String(status)).toEqual({ valid: true, error: null });
      }
    });

    const WRONG_URL = { valid: false, reason: "no-api-route", error: "The endpoint URL looks wrong: it has no /models and no chat route" };

    it("no /models and no chat route either is a wrong URL, not a valid key", async () => {
      for (const [modelsStatus, chatStatus] of [[404, 404], [404, 405], [405, 404], [405, 405]]) {
        const sent = upstream(modelsStatus, chatStatus);
        const res = await validate();
        expect(res.body, `${modelsStatus}/${chatStatus}`).toEqual(WRONG_URL);
        expect(sent).toHaveLength(2);
      }
    });

    it("a redirect from the chat path proves nothing about the key: a wrong URL", async () => {
      // The probe fetch hands these back unfollowed: a POST 301/302/303, and any off-origin hop.
      for (const [status, location] of [[302, `${PUBLIC_URL}/login`], [307, "https://elsewhere.example/v1/chat/completions"]]) {
        mocks.probeFetch.mockResolvedValueOnce(answer(404)).mockResolvedValueOnce(new Response(null, { status, headers: { location } }));
        expect((await validate()).body, String(status)).toEqual(WRONG_URL);
      }
    });

    it("a chat-path answer that shows nothing about the key (429, 5xx, other 4xx) fails it as unverified", async () => {
      for (const status of [429, 500, 502, 409]) {
        upstream(404, status);
        expect((await validate()).body, String(status)).toEqual({
          valid: false, reason: "unverified", upstreamStatus: status,
          error: `Couldn't check the key: the endpoint answered ${status} to the check. Try again.`,
        });
      }
    });

    it("both probes give up after 8s or when the caller goes away", async () => {
      const timeout = vi.spyOn(AbortSignal, "timeout");
      // A fetch that hangs until its signal aborts.
      const hang = (_url, init) => new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
      });
      try {
        for (const step of ["/models", "chat"]) {
          const caller = new AbortController();
          mocks.probeFetch.mockReset();
          if (step === "/models") mocks.probeFetch.mockImplementationOnce(hang);
          else mocks.probeFetch.mockResolvedValueOnce(answer(404)).mockImplementationOnce(hang);
          timeout.mockClear();
          const pending = validateRoute.POST({ ...req({ provider: NODE_ID, apiKey: "sk-b", baseUrl: PUBLIC_URL }), signal: caller.signal });
          await vi.waitFor(() => expect(mocks.probeFetch).toHaveBeenCalledTimes(step === "/models" ? 1 : 2));
          caller.abort(new Error("caller gone"));
          const res = await pending;
          expect(res.body, step).toEqual({ valid: false, error: "caller gone" });
          expect(timeout, step).toHaveBeenCalledWith(8000);
          expect(timeout, step).toHaveBeenCalledTimes(step === "/models" ? 1 : 2);
        }
      } finally {
        timeout.mockRestore();
      }
    });

    it("a 405 on /models falls back to the chat path too", async () => {
      const sent = upstream(405, 400);
      expect((await validate()).body.valid).toBe(true);
      expect(sent.map((s) => s.url)).toEqual([`${PUBLIC_URL}/models`, `${PUBLIC_URL}/chat/completions`]);
    });

    it("a /models answer other than 404/405 decides alone", async () => {
      for (const [status, valid] of [[200, true], [401, false], [403, false], [429, false], [500, false], [502, false]]) {
        const sent = upstream(status, 400);
        expect((await validate()).body.valid, String(status)).toBe(valid);
        expect(sent, String(status)).toHaveLength(1);
      }
    });

    it("a network error on the chat path fails the key like one on /models", async () => {
      mocks.probeFetch.mockResolvedValueOnce(answer(404)).mockRejectedValueOnce(new Error("connect ECONNREFUSED"));
      const res = await validate();
      expect(res.body).toEqual({ valid: false, error: "connect ECONNREFUSED" });
    });

    it("posts where routing posts: the node's path and query overrides, its auth header style, /responses for a Responses node", async () => {
      const overrides = { path: "/chat", query: "api-version=2" };
      db.nodes.push(
        { id: "openai-compatible-chat-ovr", type: "openai-compatible", prefix: "ov", apiType: "chat", baseUrl: "https://api.example.com/v1", name: "OV", overrides, apiKeyHeader: "api-key" },
        // No "responses" in the id: the node's apiType alone must pick the path.
        { id: "openai-compatible-acme", type: "openai-compatible", prefix: "ac", apiType: "responses", baseUrl: "https://api.example.com/v1", name: "AC" },
      );
      let sent = upstream(404, 400);
      await validateRoute.POST(req({ provider: "openai-compatible-chat-ovr", apiKey: "sk-o", baseUrl: PUBLIC_URL }));
      expect(sent.map((s) => s.url)).toEqual([`${PUBLIC_URL}/models?api-version=2`, `${PUBLIC_URL}/chat?api-version=2`]);
      expect(sent[1].init.headers["api-key"]).toBe("sk-o");
      expect(sent[1].init.headers.Authorization).toBeUndefined();
      // The URL a request on that key goes to.
      expect(getExecutor("openai-compatible-chat-ovr").buildUrl("m", false, 0, { providerSpecificData: { baseUrl: PUBLIC_URL, overrides } })).toBe(sent[1].url);

      sent = upstream(404, 400);
      await validateRoute.POST(req({ provider: "openai-compatible-acme", apiKey: "sk-r", baseUrl: PUBLIC_URL }));
      expect(sent[1].url).toBe(`${PUBLIC_URL}/responses`);
    });
  });

  it("an internal URL from a remote caller is refused before any request", async () => {
    db.local = false;
    const res = await validateRoute.POST(req({ provider: NODE_ID, apiKey: "sk-b", baseUrl: "http://169.254.169.254/latest" }));
    expect(res.status).toBe(400);
    expect(mocks.probeFetch).not.toHaveBeenCalled();
  });

  it("a local caller keeps the plain fetch", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(okRes());
    try {
      const res = await validateRoute.POST(req({ provider: NODE_ID, apiKey: "sk-b", baseUrl: "http://127.0.0.1:8080/v1" }));
      expect(res.body.valid).toBe(true);
      expect(spy).toHaveBeenCalledWith("http://127.0.0.1:8080/v1/models", expect.anything());
      expect(mocks.makeProbeFetch).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

describe("node edits and a key's learned beta flags", () => {
  it("does not copy the node's flags onto a key with its own endpoint", async () => {
    const { mergeConnectionData } = await import("../../src/shared/utils/nodeQuirkMerge.ts");
    const node = { droppedBetas: ["node-1"], stripBeta: false };
    expect(mergeConnectionData({ ownBaseUrl: true, droppedBetas: ["own-1"] }, node).droppedBetas).toEqual(["own-1"]);
    expect(mergeConnectionData({ ownBaseUrl: true }, node).droppedBetas).toBeUndefined();
    expect(mergeConnectionData({ droppedBetas: ["k-1"] }, node).droppedBetas.sort()).toEqual(["k-1", "node-1"]);
  });
});
