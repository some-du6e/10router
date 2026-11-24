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
// The re-detect route reads nodes and keys through localDb.
vi.mock("@/lib/localDb", () => ({
  getProviderNodeById: vi.fn(async (id) => state.nodes.find((n) => n.id === id) || null),
  updateProviderNode: vi.fn(async (id, data) => {
    const i = state.nodes.findIndex((n) => n.id === id);
    state.nodes[i] = { ...state.nodes[i], ...data };
    return state.nodes[i];
  }),
  getProviderConnections: vi.fn(async () => state.connections),
  updateProviderConnection: vi.fn(),
  getCustomModels: vi.fn(async () => []),
  addCustomModel: vi.fn(),
  deleteCustomModel: vi.fn(),
  getSettings: vi.fn(async () => ({})),
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
const providers = await import("../../src/app/api/providers/route.js");
const kiroApiKey = await import("../../src/app/api/oauth/kiro/api-key/route.js");
const redetect = await import("../../src/app/api/providers/[id]/redetect/route.js");
const proxyTestRoute = await import("../../src/app/api/settings/proxy-test/route.js");
const keyCheck = await import("../../src/app/api/providers/validate/route.js");
const { classifyPoolTest, healthCheckSummary } = await import("../../src/shared/utils/proxyHealth.js");

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

  it("checks a stored private URL when a remote session switches the pool back on", async () => {
    state.pools = [{ id: "pool-1", name: "lan", type: "http", proxyUrl: "http://10.0.0.8:3128", isActive: false }];
    const on = await pool.PUT(req({ isActive: true }), params("pool-1"));
    expect(on.status).toBe(400);
    expect(on.body).toEqual({ error: PRIVATE_URL_ERROR, field: "proxyUrl" });
    expect(state.pools[0].isActive).toBe(false);
    // Edits that leave it off pass; so does switching it on from this machine.
    expect((await pool.PUT(req({ name: "lan2" }), params("pool-1"))).status).toBe(200);
    state.local = true;
    expect((await pool.PUT(req({ isActive: true }), params("pool-1"))).status).toBe(200);
    expect(state.pools[0].isActive).toBe(true);
  });

  it("keeps the type of a Deno relay on edit", async () => {
    state.pools = [{ id: "pool-1", name: "d", type: "deno", proxyUrl: "https://relay.example.deno.net/?relay_key=k" }];
    const res = await pool.PUT(req({ name: "d2", type: "deno" }), params("pool-1"));
    expect(res.status).toBe(200);
    expect(state.pools[0].type).toBe("deno");
  });

  it("won't test a stored private URL from a remote session, says so, and leaves the pool alone", async () => {
    state.pools = [{ id: "pool-1", name: "lan", type: "http", proxyUrl: "http://10.0.0.8:3128", isActive: true, testStatus: "active" }];
    const refused = await poolTest.POST(req({}), params("pool-1"));
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({ ok: false, notAllowed: true, error: PRIVATE_URL_ERROR });
    expect(mocks.testProxyUrl).not.toHaveBeenCalled();
    expect(state.pools[0]).toMatchObject({ isActive: true, testStatus: "active" });
    // The health check counts it as not tested, never as dead.
    expect(classifyPoolTest(false, refused.body)).toBe("skipped");
    expect(classifyPoolTest(false, { ok: false, error: "timeout" })).toBe("dead");
    expect(classifyPoolTest(true, { ok: true })).toBe("alive");
    expect(healthCheckSummary({ alive: 1, dead: 0, skipped: 2 })).toBe("Alive: 1, Dead: 0, Not tested from this session (private host): 2");

    state.local = true;
    const ok = await poolTest.POST(req({}), params("pool-1"));
    expect(ok.status).toBe(200);
    expect(mocks.testProxyUrl).toHaveBeenCalledWith({ proxyUrl: "http://10.0.0.8:3128" });
  });

  it("the settings proxy test applies the same rule to the proxy and the test page", async () => {
    const proxy = await proxyTestRoute.POST(req({ proxyUrl: "http://10.0.0.8:3128" }));
    expect(proxy.status).toBe(400);
    expect(proxy.body.field).toBe("proxyUrl");
    const page = await proxyTestRoute.POST(req({ proxyUrl: "http://8.8.8.8:3128", testUrl: "http://169.254.169.254/latest" }));
    expect(page.status).toBe(400);
    expect(page.body.field).toBe("testUrl");
    expect(mocks.testProxyUrl).not.toHaveBeenCalled();
    state.local = true;
    expect((await proxyTestRoute.POST(req({ proxyUrl: "http://10.0.0.8:3128" }))).status).toBe(200);
  });
});

describe("provider key check", () => {
  it("gives the URLs it sends the key to the saving rule, and pins a remote caller's probe", async () => {
    const azure = await keyCheck.POST(req({ provider: "azure", apiKey: "k", providerSpecificData: { azureEndpoint: "http://10.0.0.6" } }));
    expect(azure.status).toBe(400);
    expect(azure.body).toEqual({ valid: false, error: PRIVATE_URL_ERROR, field: "azureEndpoint" });
    const ollama = await keyCheck.POST(req({ provider: "ollama-local", providerSpecificData: { baseUrl: "http://10.0.0.7:11434" } }));
    expect(ollama.body).toMatchObject({ valid: false, field: "baseUrl" });
    const proxied = await keyCheck.POST(req({ provider: "opencode-zen", apiKey: "k", providerSpecificData: { connectionProxyEnabled: true, connectionProxyUrl: "http://10.0.0.8:3128" } }));
    expect(proxied.body).toMatchObject({ valid: false, field: "connectionProxyUrl" });
    expect(mocks.makeProbeFetch).not.toHaveBeenCalled();

    mocks.probeFetch.mockResolvedValue(new Response("{}", { status: 200 }));
    const ok = await keyCheck.POST(req({ provider: "azure", apiKey: "k", providerSpecificData: { azureEndpoint: "https://203.0.113.9" } }));
    expect(ok.body).toMatchObject({ valid: true });
    expect(mocks.makeProbeFetch).toHaveBeenCalledWith(true);
    expect(mocks.probeFetch.mock.calls[0][0]).toMatch(/^https:\/\/203\.0\.113\.9\/openai\/deployments\//);
  });
});

describe("settings proxy test input", () => {
  it("refuses a proxy or test URL that isn't a string", async () => {
    const proxy = await proxyTestRoute.POST(req({ proxyUrl: ["http://10.0.0.5:3128"] }));
    expect(proxy.status).toBe(400);
    expect(proxy.body).toEqual({ ok: false, error: "proxyUrl must be a string", field: "proxyUrl" });
    const page = await proxyTestRoute.POST(req({ proxyUrl: "http://8.8.8.8:3128", testUrl: ["http://10.0.0.6:8080/"] }));
    expect(page.status).toBe(400);
    expect(page.body.field).toBe("testUrl");
    expect(mocks.testProxyUrl).not.toHaveBeenCalled();
  });
});

describe("connection URLs saved through any field", () => {
  it("checks a proxy saved switched off, and a stored one when it's switched on", async () => {
    state.connections = [{ id: "o1", provider: "openai", authType: "apikey", providerSpecificData: {} }];
    const off = await connection.PUT(req({ connectionProxyEnabled: false, connectionProxyUrl: "http://10.0.0.8:3128" }), params("o1"));
    expect(off.status).toBe(400);
    expect(off.body.field).toBe("connectionProxyUrl");

    state.local = true; // saved off from this machine
    expect((await connection.PUT(req({ connectionProxyEnabled: false, connectionProxyUrl: "http://10.0.0.8:3128" }), params("o1"))).status).toBe(200);
    expect(state.connections[0].providerSpecificData).toMatchObject({ connectionProxyEnabled: false, connectionProxyUrl: "http://10.0.0.8:3128" });
    state.local = false; // then switched on from elsewhere
    const top = await connection.PUT(req({ connectionProxyEnabled: true, connectionProxyUrl: "http://10.0.0.8:3128" }), params("o1"));
    expect(top.status).toBe(400);
    const nested = await connection.PUT(req({ providerSpecificData: { connectionProxyEnabled: true } }), params("o1"));
    expect(nested.status).toBe(400);
    expect(state.connections[0].providerSpecificData.connectionProxyEnabled).toBe(false);
    // Already in effect: other edits pass.
    expect((await connection.PUT(req({ name: "renamed" }), params("o1"))).status).toBe(200);
  });

  it("POST /api/providers refuses a private connection proxy, on or off, and a bad Kiro region", async () => {
    for (const connectionProxyEnabled of [true, false]) {
      const res = await providers.POST(req({ provider: "openai", apiKey: "sk-x", name: "o", connectionProxyEnabled, connectionProxyUrl: "http://10.0.0.8:3128" }));
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: PRIVATE_URL_ERROR, field: "connectionProxyUrl" });
    }
    // Kiro keys are created through their own route.
    const kiro = await kiroApiKey.POST(req({ apiKey: "ksk_x", region: "x.attacker.example/" }));
    expect(kiro.status).toBe(400);
    expect(kiro.body.error).toBe("Invalid region");
    expect(state.created).toHaveLength(0);
  });

  it("refuses a private baseUrl on a provider that isn't a custom node, and a private azureEndpoint", async () => {
    const stt = await providers.POST(req({ provider: "ollama-local", apiKey: "x", name: "ol", baseUrl: "http://10.0.0.7:11434" }));
    expect(stt.status).toBe(400);
    expect(stt.body.field).toBe("baseUrl");

    state.connections = [{ id: "az", provider: "azure", authType: "apikey", providerSpecificData: { azureEndpoint: "http://10.0.0.6" } }];
    const azure = await connection.PUT(req({ providerSpecificData: { azureEndpoint: "http://169.254.169.254" } }), params("az"));
    expect(azure.status).toBe(400);
    expect(azure.body.field).toBe("azureEndpoint");
    // The stored one, already in effect, doesn't block other edits.
    expect((await connection.PUT(req({ providerSpecificData: { azureEndpoint: "http://10.0.0.6", deployment: "d" } }), params("az"))).status).toBe(200);

    state.local = true;
    expect((await providers.POST(req({ provider: "ollama-local", apiKey: "x", name: "ol", baseUrl: "http://10.0.0.7:11434" }))).status).toBe(201);
  });

  it("a key on a LAN custom node can still be added from a remote session (the node's URL isn't the key's)", async () => {
    const res = await providers.POST(req({ provider: NODE.id, apiKey: "sk-n", name: "n", providerSpecificData: { baseUrl: NODE.baseUrl } }));
    expect(res.status).toBe(201);
    expect(state.created[0].providerSpecificData.baseUrl).toBe(NODE.baseUrl);
  });

  it("node PUT refuses a new private per-endpoint proxy, and keeps a stored one", async () => {
    state.nodes = [{ ...NODE, overrides: { proxy: "http://10.0.0.5:8080" } }];
    const changed = await node.PUT(req({ name: "Local", prefix: "x", apiType: "chat", baseUrl: NODE.baseUrl, quirks: { overrides: { proxy: "http://10.0.0.6:8080" } } }), params(NODE.id));
    expect(changed.status).toBe(400);
    expect(changed.body).toEqual({ error: PRIVATE_URL_ERROR, field: "proxy" });
    const kept = await node.PUT(req({ name: "Local", prefix: "x", apiType: "chat", baseUrl: NODE.baseUrl, quirks: { overrides: { proxy: "http://10.0.0.5:8080" } } }), params(NODE.id));
    expect(kept.status).toBe(200);
  });

  it("refuses a URL sent as anything but a string, which the runtime would read as one", async () => {
    state.connections = [
      { id: "o1", provider: "openai", authType: "apikey", providerSpecificData: {} },
      { id: "c1", provider: NODE.id, authType: "apikey", providerSpecificData: { baseUrl: NODE.baseUrl } },
    ];
    const proxy = await connection.PUT(req({ providerSpecificData: { connectionProxyEnabled: true, connectionProxyUrl: ["http://10.0.0.5:3128"] } }), params("o1"));
    expect(proxy.status).toBe(400);
    expect(proxy.body).toEqual({ error: "connectionProxyUrl must be a string", field: "connectionProxyUrl" });
    const endpointProxy = await connection.PUT(req({ providerSpecificData: { overrides: { proxy: ["http://10.0.0.5:3128"] } } }), params("c1"));
    expect(endpointProxy.status).toBe(400);
    expect(endpointProxy.body).toEqual({ error: "proxy must be a string", field: "proxy" });
    expect(state.connections[0].providerSpecificData).toEqual({});
    expect(state.connections[1].providerSpecificData).toEqual({ baseUrl: NODE.baseUrl });
  });

  it("re-detect apply refuses a private per-endpoint proxy in the accepted quirks", async () => {
    state.nodes = [{ ...NODE }];
    const res = await redetect.PUT(req({ quirks: { overrides: { proxy: "socks5://10.0.0.9:1080" } } }), params(NODE.id));
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: PRIVATE_URL_ERROR, field: "proxy" });
    expect(state.nodes[0].overrides).toBeUndefined();
    expect((await redetect.PUT(req({ quirks: { overrides: { proxy: "http://8.8.8.8:3128" } } }), params(NODE.id))).status).toBe(200);
  });
});
