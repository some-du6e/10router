import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PRIVATE_URL_ERROR } from "../../src/shared/constants/privateUrl.js";

// local: the caller is on this machine. session: a signed-in dashboard session
// (what ALLOW_PRIVATE_ENDPOINT_URLS trusts; see hasSignedInDashboardSession).
const state = vi.hoisted(() => ({ local: false, session: false, nodes: [], connections: [], created: [], pools: [] }));
const mocks = vi.hoisted(() => ({
  json: vi.fn((body, init) => ({ status: init?.status || 200, body })),
  probeFetch: vi.fn(),
  makeProbeFetch: vi.fn(),
  fetchPublic: vi.fn(),
  discoverModels: vi.fn(),
  testProxyUrl: vi.fn(),
  kiroRefresh: vi.fn(),
}));

vi.mock("next/server", () => ({ NextResponse: { json: mocks.json } }));
vi.mock("@/dashboardGuard", () => ({
  isLocalRequest: () => state.local,
  hasSignedInDashboardSession: async () => state.session,
}));
vi.mock("@/lib/probeFetch.js", async (orig) => ({ ...(await orig()), makeProbeFetch: mocks.makeProbeFetch }));
vi.mock("@/shared/utils/ssrfGuard.js", async (orig) => ({ ...(await orig()), fetchPublic: mocks.fetchPublic }));
vi.mock("@/lib/endpointDetect.js", async (orig) => ({ ...(await orig()), discoverModels: mocks.discoverModels }));
vi.mock("@/lib/endpointCatalog.js", () => ({ getEndpointCatalog: async () => ({ providers: [], labs: [] }) }));
vi.mock("@/lib/network/proxyTest", () => ({ testProxyUrl: mocks.testProxyUrl }));
vi.mock("@/lib/oauth/services/kiro", () => ({
  KiroService: class {
    refreshToken(...a) { return mocks.kiroRefresh(...a); }
    extractEmailFromJWT() { return null; }
  },
}));
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
  getProviderConnectionById: vi.fn(async (id) => state.connections.find((c) => c.id === id) || null),
  updateProviderConnection: vi.fn(async (id, data) => {
    const c = state.connections.find((x) => x.id === id);
    if (c) Object.assign(c, data);
    return c;
  }),
  deleteProviderConnectionsByProvider: vi.fn(),
  deleteProviderNode: vi.fn(),
  createProviderConnection: vi.fn(async (c) => { state.created.push(c); return { id: "conn-new", ...c }; }),
  getProxyPools: vi.fn(async () => state.pools),
  getProxyPoolById: vi.fn(async (id) => state.pools.find((p) => p.id === id) || null),
  createProxyPool: vi.fn(async (p) => { const pool = { id: `pool-${state.pools.length + 1}`, ...p }; state.pools.push(pool); return pool; }),
  updateProxyPool: vi.fn(async (id, data) => {
    const i = state.pools.findIndex((p) => p.id === id);
    state.pools[i] = { ...state.pools[i], ...data };
    return state.pools[i];
  }),
}));

const suggested = await import("../../src/app/api/providers/suggested-models/route.js");
const nodes = await import("../../src/app/api/provider-nodes/route.js");
const node = await import("../../src/app/api/provider-nodes/[id]/route.js");
const validate = await import("../../src/app/api/provider-nodes/validate/route.js");
const gitlabPat = await import("../../src/app/api/oauth/gitlab/pat/route.js");
const { guardTarget } = await import("../../src/app/api/provider-nodes/detect/ndjson.js");
const discover = await import("../../src/app/api/providers/[id]/discover-models/route.js");
const connection = await import("../../src/app/api/providers/[id]/route.js");
const kiroImport = await import("../../src/app/api/oauth/kiro/import/route.js");
const pools = await import("../../src/app/api/proxy-pools/route.js");
const pool = await import("../../src/app/api/proxy-pools/[id]/route.js");
const poolTest = await import("../../src/app/api/proxy-pools/[id]/test/route.js");
const oauthAction = await import("../../src/app/api/oauth/[provider]/[action]/route.js");

const req = (body, url = "http://gw.example/api") => ({ url, json: async () => body, headers: new Headers() });
const params = (id) => ({ params: Promise.resolve({ id }) });
const NODE = { id: "openai-compatible-chat-x", type: "openai-compatible", prefix: "x", apiType: "chat", baseUrl: "http://127.0.0.1:11434/v1", name: "Local" };
const LAN = "http://10.0.0.20:11434/v1";
const allowPrivate = () => vi.stubEnv("ALLOW_PRIVATE_ENDPOINT_URLS", "true");

beforeEach(() => {
  state.local = false;
  state.session = false;
  state.nodes = [{ ...NODE }];
  state.connections = [];
  state.created = [];
  state.pools = [];
  mocks.probeFetch.mockReset();
  mocks.makeProbeFetch.mockReset().mockReturnValue(mocks.probeFetch);
  mocks.fetchPublic.mockReset();
  mocks.discoverModels.mockReset().mockResolvedValue({ models: [], steps: [] });
  mocks.testProxyUrl.mockReset().mockResolvedValue({ ok: true, status: 200 });
  mocks.kiroRefresh.mockReset().mockResolvedValue({ accessToken: "a.b.c", refreshToken: "r", expiresIn: 3600 });
});
afterEach(() => vi.unstubAllEnvs());

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
    expect(created.body.error).toBe(PRIVATE_URL_ERROR);
    const anthropic = await nodes.POST(req({ name: "N", prefix: "na", type: "anthropic-compatible", baseUrl: "http://10.0.0.1/v1/messages" }));
    expect(anthropic.status).toBe(400);
    const embedding = await nodes.POST(req({ name: "E", prefix: "ne", type: "custom-embedding", baseUrl: "http://10.0.0.2/v1/embeddings" }));
    expect(embedding.status).toBe(400);
    expect(embedding.body.error).toBe(PRIVATE_URL_ERROR);
    expect(state.nodes).toHaveLength(1);

    const edited = await node.PUT(req({ name: "Local", prefix: "x", apiType: "chat", baseUrl: "http://192.168.0.10/v1" }), params(NODE.id));
    expect(edited.status).toBe(400);
    expect(state.nodes[0].baseUrl).toBe(NODE.baseUrl);
  });

  it("refuses an internal per-endpoint proxy from a remote caller", async () => {
    const res = await nodes.POST(req({ name: "N", prefix: "np", apiType: "chat", baseUrl: "https://api.example.com/v1", quirks: { overrides: { proxy: "socks5://10.0.0.9:1080" } } }));
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: PRIVATE_URL_ERROR, field: "proxy" });
  });

  it("lets a remote caller rename a node that already points at a local model, as stored or as the dashboard cleans it", async () => {
    const res = await node.PUT(req({ name: "Renamed", prefix: "x", apiType: "chat", baseUrl: NODE.baseUrl }), params(NODE.id));
    expect(res.status).toBe(200);
    expect(state.nodes[0].name).toBe("Renamed");

    state.nodes.push(
      { id: "anthropic-compatible-l", type: "anthropic-compatible", prefix: "al", baseUrl: "http://10.0.0.3/v1", name: "A" },
      { id: "custom-embedding-l", type: "custom-embedding", prefix: "el", baseUrl: "http://10.0.0.4/v1", name: "E" },
    );
    const anthropic = await node.PUT(req({ name: "A2", prefix: "al", baseUrl: "http://10.0.0.3/v1/messages/" }), params("anthropic-compatible-l"));
    expect(anthropic.status).toBe(200);
    const embedding = await node.PUT(req({ name: "E2", prefix: "el", baseUrl: "http://10.0.0.4/v1/embeddings" }), params("custom-embedding-l"));
    expect(embedding.status).toBe(200);
  });

  it("keeps local callers free to use local models", async () => {
    state.local = true;
    const res = await nodes.POST(req({ name: "LM", prefix: "lm", apiType: "chat", baseUrl: "http://localhost:1234/v1" }));
    expect(res.status).toBe(201);
  });
});

describe("ALLOW_PRIVATE_ENDPOINT_URLS", () => {
  it("lets a signed-in remote dashboard session save, edit and probe a LAN endpoint", async () => {
    allowPrivate();
    state.session = true;
    const created = await nodes.POST(req({ name: "LAN", prefix: "lan", apiType: "chat", baseUrl: LAN }));
    expect(created.status).toBe(201);
    const edited = await node.PUT(req({ name: "Local", prefix: "x", apiType: "chat", baseUrl: "http://10.0.0.21/v1" }), params(NODE.id));
    expect(edited.status).toBe(200);
    mocks.probeFetch.mockResolvedValue({ ok: true, status: 200 });
    await validate.POST(req({ baseUrl: LAN, apiKey: "k" }));
    expect(mocks.makeProbeFetch).toHaveBeenCalledWith(false);
  });

  it("does nothing without a signed-in session (requireLogin off, unclaimed, or the management API's internal requests)", async () => {
    allowPrivate();
    state.session = false;
    const res = await nodes.POST(req({ name: "LAN", prefix: "lan", apiType: "chat", baseUrl: LAN }));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe(PRIVATE_URL_ERROR);
  });

  it("only the value true opts in", async () => {
    vi.stubEnv("ALLOW_PRIVATE_ENDPOINT_URLS", "1");
    state.session = true;
    const res = await nodes.POST(req({ name: "LAN", prefix: "lan", apiType: "chat", baseUrl: LAN }));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe(PRIVATE_URL_ERROR);
  });

  it("covers endpoint detection and model discovery", async () => {
    const off = await guardTarget(req({}), LAN);
    expect(off.status).toBe(400);
    expect(off.body.error).toBe(PRIVATE_URL_ERROR);

    state.connections = [{ id: "c1", provider: NODE.id, apiKey: "k", providerSpecificData: { baseUrl: LAN } }];
    const refused = await discover.GET(req({}), params("c1"));
    expect(refused.status).toBe(400);
    expect(mocks.discoverModels).not.toHaveBeenCalled();

    allowPrivate();
    state.session = true;
    expect(await guardTarget(req({}), LAN)).toEqual({ remote: false });
    const allowed = await discover.GET(req({}), params("c1"));
    expect(allowed.status).toBe(200);
    expect(mocks.makeProbeFetch).toHaveBeenCalledWith(false);
  });

  it("covers GitLab PAT and OAuth sign-in", async () => {
    mocks.probeFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ username: "u" }) });
    const refused = await gitlabPat.POST(req({ token: "glpat", baseUrl: "http://10.0.0.5" }));
    expect(refused.status).toBe(400);
    expect(refused.body.error).toBe(PRIVATE_URL_ERROR);
    const exchange = () => oauthAction.POST(
      req({ code: "c", redirectUri: "http://localhost/cb", codeVerifier: "v", state: "s", meta: { baseUrl: "http://10.0.0.5", clientId: "id" } }),
      { params: Promise.resolve({ provider: "gitlab", action: "exchange" }) },
    );
    const refusedExchange = await exchange();
    expect(refusedExchange.status).toBe(400);
    expect(refusedExchange.body.error).toBe(PRIVATE_URL_ERROR);
    expect(mocks.probeFetch).not.toHaveBeenCalled();

    allowPrivate();
    state.session = true;
    expect((await gitlabPat.POST(req({ token: "glpat", baseUrl: "http://10.0.0.5" }))).status).toBe(200);
    expect(mocks.makeProbeFetch).toHaveBeenLastCalledWith(false);
    mocks.probeFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ access_token: "t", username: "u" }) });
    expect((await exchange()).status).toBe(200);
    expect(mocks.makeProbeFetch).toHaveBeenLastCalledWith(false);
  });

  it("a local GitLab PAT check skips the public-only probe", async () => {
    state.local = true;
    mocks.probeFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ username: "u" }) });
    expect((await gitlabPat.POST(req({ token: "glpat", baseUrl: "http://10.0.0.5" }))).status).toBe(200);
    expect(mocks.makeProbeFetch).toHaveBeenCalledWith(false);
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

  it("maps a blocked hop to the private-URL error", async () => {
    mocks.probeFetch.mockRejectedValue(new Error("Blocked URL: hostname resolves to an internal host"));
    const res = await validate.POST(req({ baseUrl: "https://rebind.example/v1", apiKey: "k" }));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe(PRIVATE_URL_ERROR);
  });

  it("names the origin of a redirect it didn't follow", async () => {
    mocks.probeFetch.mockResolvedValue(new Response(null, { status: 302, headers: { location: "https://other.example.com/v1/models" } }));
    const res = await validate.POST(req({ baseUrl: "https://api.example.com/v1", apiKey: "k" }));
    expect(res.body).toEqual({ valid: false, error: "The server redirected to https://other.example.com. Use that URL instead." });
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
    mocks.probeFetch.mockResolvedValue({ ok: false, status: 403, headers: new Headers(), text: async () => "internal secret page" });
    const res = await gitlabPat.POST(req({ token: "glpat", baseUrl: "https://git.example.com" }));
    expect(mocks.makeProbeFetch).toHaveBeenCalledWith(true);
    expect(res.status).toBe(401);
    expect(JSON.stringify(res.body)).not.toContain("internal secret page");

    mocks.probeFetch.mockRejectedValue(new Error("Blocked URL: internal host"));
    const blocked = await gitlabPat.POST(req({ token: "glpat", baseUrl: "https://rebind.example.com" }));
    expect(blocked.status).toBe(400);
    expect(blocked.body.error).toBe(PRIVATE_URL_ERROR);
    expect(state.created).toHaveLength(0);
  });

  it("names the origin of a cross-origin redirect", async () => {
    mocks.probeFetch.mockResolvedValue(new Response(null, { status: 301, headers: { location: "https://gitlab.example.org/api/v4/user" } }));
    const res = await gitlabPat.POST(req({ token: "glpat", baseUrl: "https://git.example.com" }));
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("The server redirected to https://gitlab.example.org. Use that URL instead.");
  });
});

describe("connection settings", () => {
  const KIRO = { id: "k1", provider: "kiro", authType: "oauth", providerSpecificData: { authMethod: "idc", clientId: "c", clientSecret: "s", region: "eu-central-1" } };

  it("refuses a Kiro region that isn't an AWS region, so a refresh can't be sent elsewhere", async () => {
    state.connections = [structuredClone(KIRO)];
    const res = await connection.PUT(req({ providerSpecificData: { region: "x.attacker.example/" } }), params("k1"));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid region");
    expect(state.connections[0].providerSpecificData.region).toBe("eu-central-1");
    const arn = await connection.PUT(req({ providerSpecificData: { profileArn: "arn:aws:codewhisperer:x@evil.example/#:123456789012:profile/AB" } }), params("k1"));
    expect(arn.status).toBe(400);
    expect((await connection.PUT(req({ providerSpecificData: { region: "ap-southeast-2" } }), params("k1"))).status).toBe(200);
  });

  it("refuses an internal connection proxy from a remote caller, sent either way", async () => {
    state.connections = [{ id: "o1", provider: "openai", authType: "apikey", providerSpecificData: {} }];
    const top = await connection.PUT(req({ connectionProxyEnabled: true, connectionProxyUrl: "http://10.0.0.8:3128" }), params("o1"));
    expect(top.status).toBe(400);
    expect(top.body.error).toBe(PRIVATE_URL_ERROR);
    const nested = await connection.PUT(req({ providerSpecificData: { connectionProxyEnabled: true, connectionProxyUrl: "127.0.0.1:7890" } }), params("o1"));
    expect(nested.status).toBe(400);
    state.local = true;
    expect((await connection.PUT(req({ connectionProxyEnabled: true, connectionProxyUrl: "127.0.0.1:7890" }), params("o1"))).status).toBe(200);
  });
});

describe("kiro import", () => {
  it("rejects an invalid profile ARN or region with 400 instead of dropping it", async () => {
    const bad = await kiroImport.POST(req({ refreshToken: "rt", profileArn: "arn:aws:codewhisperer:evil.example:1:profile/x" }));
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe("Invalid profileArn");
    const region = await kiroImport.POST(req({ refreshToken: "rt", clientId: "c", clientSecret: "s", region: "evil.example/#" }));
    expect(region.status).toBe(400);
    expect(mocks.kiroRefresh).not.toHaveBeenCalled();

    const ok = await kiroImport.POST(req({ refreshToken: "rt", profileArn: "arn:aws:codewhisperer:us-east-1:123456789012:profile/ABC" }));
    expect(ok.status).toBe(200);
    expect(state.created[0].providerSpecificData.profileArn).toBe("arn:aws:codewhisperer:us-east-1:123456789012:profile/ABC");
  });
});

describe("proxy pools", () => {
  it("refuses an internal proxy or relay URL from a remote caller on create and edit", async () => {
    for (const proxyUrl of ["http://10.0.0.8:3128", "127.0.0.1:7890", "socks5://localhost:1080"]) {
      const res = await pools.POST(req({ name: "p", proxyUrl, type: "http" }));
      expect(res.status, proxyUrl).toBe(400);
      expect(res.body.error).toBe(PRIVATE_URL_ERROR);
    }
    const relay = await pools.POST(req({ name: "r", proxyUrl: "http://169.254.169.254/", type: "cloudflare" }));
    expect(relay.status).toBe(400);
    expect(state.pools).toHaveLength(0);

    expect((await pools.POST(req({ name: "ok", proxyUrl: "http://8.8.8.8:3128", type: "http" }))).status).toBe(201);
    const edited = await pool.PUT(req({ proxyUrl: "http://10.0.0.8:3128" }), params("pool-1"));
    expect(edited.status).toBe(400);
    expect(state.pools[0].proxyUrl).toBe("http://8.8.8.8:3128");
  });

  it("keeps the type of a Deno relay on edit", async () => {
    state.pools = [{ id: "pool-1", name: "d", type: "deno", proxyUrl: "https://relay.example.deno.net/?relay_key=k" }];
    const res = await pool.PUT(req({ name: "d2", type: "deno" }), params("pool-1"));
    expect(res.status).toBe(200);
    expect(state.pools[0].type).toBe("deno");
  });

  it("tests a stored URL under the same rule, and lets a local caller test a LAN proxy", async () => {
    state.pools = [{ id: "pool-1", name: "lan", type: "http", proxyUrl: "http://10.0.0.8:3128" }];
    const refused = await poolTest.POST(req({}), params("pool-1"));
    expect(refused.status).toBe(400);
    expect(mocks.testProxyUrl).not.toHaveBeenCalled();

    state.local = true;
    const ok = await poolTest.POST(req({}), params("pool-1"));
    expect(ok.status).toBe(200);
    expect(mocks.testProxyUrl).toHaveBeenCalledWith({ proxyUrl: "http://10.0.0.8:3128" });
  });
});
