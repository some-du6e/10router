import { describe, it, expect, vi, beforeEach } from "vitest";

const state = vi.hoisted(() => ({ local: false, nodes: [], connections: [], created: [], pools: [] }));
const mocks = vi.hoisted(() => ({
  json: vi.fn((body, init) => ({ status: init?.status || 200, body })),
  probeFetch: vi.fn(),
  makeProbeFetch: vi.fn(),
  fetchPublic: vi.fn(),
}));

vi.mock("next/server", () => ({ NextResponse: { json: mocks.json } }));
vi.mock("@/dashboardGuard", () => ({ isLocalRequest: () => state.local }));
vi.mock("@/lib/probeFetch.js", () => ({ makeProbeFetch: mocks.makeProbeFetch }));
vi.mock("@/shared/utils/ssrfGuard.js", async (orig) => ({ ...(await orig()), fetchPublic: mocks.fetchPublic }));
vi.mock("@/models", () => ({
  getProviderNodes: vi.fn(async () => state.nodes),
  getProviderNodeById: vi.fn(async (id) => state.nodes.find((n) => n.id === id) || null),
  createProviderNode: vi.fn(async (n) => { state.nodes.push(n); return n; }),
  updateProviderNode: vi.fn(async (id, data) => {
    const i = state.nodes.findIndex((n) => n.id === id);
    state.nodes[i] = { ...state.nodes[i], ...data };
    return state.nodes[i];
  }),
  getProviderConnections: vi.fn(async () => state.connections),
  updateProviderConnection: vi.fn(),
  deleteProviderConnectionsByProvider: vi.fn(),
  deleteProviderNode: vi.fn(),
  createProviderConnection: vi.fn(async (c) => { state.created.push(c); return c; }),
  createProxyPool: vi.fn(async (p) => { state.pools.push(p); return p; }),
}));

const suggested = await import("../../src/app/api/providers/suggested-models/route.js");
const nodes = await import("../../src/app/api/provider-nodes/route.js");
const node = await import("../../src/app/api/provider-nodes/[id]/route.js");
const validate = await import("../../src/app/api/provider-nodes/validate/route.js");
const gitlabPat = await import("../../src/app/api/oauth/gitlab/pat/route.js");
const cloudflareDeploy = await import("../../src/app/api/proxy-pools/cloudflare-deploy/route.js");

const req = (body, url = "http://gw.example/api") => ({ url, json: async () => body, headers: new Headers() });
const params = (id) => ({ params: Promise.resolve({ id }) });
const NODE = { id: "openai-compatible-chat-x", type: "openai-compatible", prefix: "x", apiType: "chat", baseUrl: "http://127.0.0.1:11434/v1", name: "Local" };

beforeEach(() => {
  state.local = false;
  state.nodes = [{ ...NODE }];
  state.connections = [];
  state.created = [];
  state.pools = [];
  mocks.probeFetch.mockReset();
  mocks.makeProbeFetch.mockReset().mockReturnValue(mocks.probeFetch);
  mocks.fetchPublic.mockReset();
});

describe("suggested-models", () => {
  it("only fetches registry catalog URLs, through the public-only fetch", async () => {
    const bad = await suggested.GET(req(null, "http://gw.example/api/providers/suggested-models?url=http%3A%2F%2F169.254.169.254%2F&type=openai"));
    expect(bad.status).toBe(400);
    expect(mocks.fetchPublic).not.toHaveBeenCalled();

    mocks.fetchPublic.mockResolvedValue({ ok: true, json: async () => ({ data: [] }) });
    const qs = new URLSearchParams({ url: "https://openrouter.ai/api/v1/models", type: "openrouter-free" });
    const ok = await suggested.GET(req(null, `http://gw.example/api/providers/suggested-models?${qs}`));
    expect(ok.status).toBe(200);
    expect(mocks.fetchPublic).toHaveBeenCalledWith("https://openrouter.ai/api/v1/models");
  });
});

describe("provider node base URL", () => {
  it("refuses an internal URL from a remote caller on create and edit", async () => {
    const created = await nodes.POST(req({ name: "N", prefix: "nn", apiType: "chat", baseUrl: "http://169.254.169.254/v1" }));
    expect(created.status).toBe(400);
    expect(created.body.error).toBe("URL not allowed");
    const anthropic = await nodes.POST(req({ name: "N", prefix: "na", type: "anthropic-compatible", baseUrl: "http://10.0.0.1/v1/messages" }));
    expect(anthropic.status).toBe(400);
    expect(state.nodes).toHaveLength(1);

    const edited = await node.PUT(req({ name: "Local", prefix: "x", apiType: "chat", baseUrl: "http://192.168.0.10/v1" }), params(NODE.id));
    expect(edited.status).toBe(400);
    expect(state.nodes[0].baseUrl).toBe(NODE.baseUrl);
  });

  it("lets a remote caller rename a node that already points at a local model", async () => {
    const res = await node.PUT(req({ name: "Renamed", prefix: "x", apiType: "chat", baseUrl: NODE.baseUrl }), params(NODE.id));
    expect(res.status).toBe(200);
    expect(state.nodes[0].name).toBe("Renamed");
  });

  it("keeps local callers free to use local models", async () => {
    state.local = true;
    const res = await nodes.POST(req({ name: "LM", prefix: "lm", apiType: "chat", baseUrl: "http://localhost:1234/v1" }));
    expect(res.status).toBe(201);
  });
});

describe("provider node validate", () => {
  it("probes through the pinned, per-hop checked fetch for remote callers", async () => {
    mocks.probeFetch.mockResolvedValue({ ok: true, status: 200 });
    const res = await validate.POST(req({ baseUrl: "https://api.example.com/v1", apiKey: "k" }));
    expect(res.body.valid).toBe(true);
    expect(mocks.makeProbeFetch).toHaveBeenCalledWith(true);
    expect(mocks.probeFetch).toHaveBeenCalledWith("https://api.example.com/v1/models", expect.objectContaining({ signal: expect.anything() }));
  });

  it("maps a blocked hop to URL not allowed", async () => {
    mocks.probeFetch.mockRejectedValue(new Error("Blocked URL: hostname resolves to an internal host"));
    const res = await validate.POST(req({ baseUrl: "https://rebind.example/v1", apiKey: "k" }));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("URL not allowed");
  });

  it("local callers probe without the public-only check", async () => {
    state.local = true;
    mocks.probeFetch.mockResolvedValue({ ok: true, status: 200 });
    await validate.POST(req({ baseUrl: "http://127.0.0.1:11434/v1", apiKey: "k" }));
    expect(mocks.makeProbeFetch).toHaveBeenCalledWith(false);
  });
});

describe("gitlab PAT", () => {
  it("rejects malformed instance URLs before fetching", async () => {
    const res = await gitlabPat.POST(req({ token: "glpat", baseUrl: "https://x.example/?" }));
    expect(res.status).toBe(400);
    expect(mocks.probeFetch).not.toHaveBeenCalled();
  });

  it("guards remote callers and never echoes the upstream body", async () => {
    mocks.probeFetch.mockResolvedValue({ ok: false, status: 403, text: async () => "internal secret page" });
    const res = await gitlabPat.POST(req({ token: "glpat", baseUrl: "https://git.example.com" }));
    expect(mocks.makeProbeFetch).toHaveBeenCalledWith(true);
    expect(res.status).toBe(401);
    expect(JSON.stringify(res.body)).not.toContain("internal secret page");

    mocks.probeFetch.mockRejectedValue(new Error("Blocked URL: internal host"));
    const blocked = await gitlabPat.POST(req({ token: "glpat", baseUrl: "http://10.0.0.5" }));
    expect(blocked.status).toBe(400);
    expect(blocked.body.error).toBe("URL not allowed");
    expect(state.created).toHaveLength(0);
  });
});

describe("cloudflare relay deploy", () => {
  it("bakes a key into the worker and stores it on the relay URL", async () => {
    const realFetch = globalThis.fetch;
    let script = "";
    globalThis.fetch = vi.fn(async (url, init) => {
      if (init?.body instanceof FormData) script = await init.body.get("index.js").text();
      return new Response(JSON.stringify({ success: true, result: { subdomain: "acct" } }), { status: 200 });
    });
    try {
      const res = await cloudflareDeploy.POST(req({ accountId: "a", apiToken: "t", projectName: "relay-x" }));
      expect(res.status).toBe(201);
    } finally {
      globalThis.fetch = realFetch;
    }
    const stored = new URL(state.pools[0].proxyUrl);
    const key = stored.searchParams.get("relay_key");
    expect(stored.origin).toBe("https://relay-x.acct.workers.dev");
    expect(key).toMatch(/^[\w-]{32}$/);
    expect(script).toContain(JSON.stringify(key));
    expect(script.indexOf(JSON.stringify(key))).toBeLessThan(script.indexOf("x-relay-target"));
  });
});
