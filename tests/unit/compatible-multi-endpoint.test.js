import { describe, it, expect, vi, beforeEach } from "vitest";

// One compatible provider, several endpoints: each key may carry its own base
// URL (providerSpecificData.baseUrl + ownBaseUrl), and key failover then fails
// over between endpoints.

const db = vi.hoisted(() => ({ nodes: [], connections: [], local: true }));
const mocks = vi.hoisted(() => ({
  json: vi.fn((body, init) => ({ status: init?.status || 200, body })),
  upstream: vi.fn(),
}));

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  default: mocks.upstream,
  proxyAwareFetch: mocks.upstream,
}));

vi.mock("next/server", () => ({ NextResponse: { json: mocks.json } }));
vi.mock("@/dashboardGuard", () => ({ isLocalRequest: () => db.local }));

vi.mock("@/models", () => ({
  getProviderNodes: vi.fn(async () => db.nodes),
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
const { getExecutor } = await import("../../open-sse/executors/index.js");
const { normalizeEndpointUrl } = await import("../../src/shared/utils/connectionBaseUrl.js");

const NODE_ID = "openai-compatible-chat-snow";
const URL_A = "https://accta.snowflakecomputing.com/api/v2/cortex/v1";
const URL_B = "https://acctb.snowflakecomputing.com/api/v2/cortex/v1";

const req = (body) => ({ json: async () => body, headers: new Headers() });
const params = (id) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  db.local = true;
  db.connections = [];
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
