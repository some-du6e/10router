import { describe, it, expect, vi, beforeEach } from "vitest";

const db = vi.hoisted(() => ({ nodes: [], connections: [], models: [], failIds: new Set() }));
const mocks = vi.hoisted(() => ({
  json: vi.fn((body, init) => ({ status: init?.status || 200, body })),
}));

vi.mock("next/server", () => ({ NextResponse: { json: mocks.json } }));

vi.mock("@/models", () => ({
  getProviderNodes: vi.fn(async () => db.nodes),
  getProviderNodeById: vi.fn(async (id) => db.nodes.find((n) => n.id === id) || null),
  createProviderNode: vi.fn(async (n) => { db.nodes.push(n); return n; }),
  updateProviderNode: vi.fn(async (id, data) => {
    const i = db.nodes.findIndex((n) => n.id === id);
    db.nodes[i] = { ...db.nodes[i], ...data };
    return db.nodes[i];
  }),
  getProviderConnections: vi.fn(async ({ provider }) => db.connections.filter((c) => c.provider === provider)),
  updateProviderConnection: vi.fn(async (id, data) => {
    const c = db.connections.find((x) => x.id === id);
    Object.assign(c, data);
    return c;
  }),
  deleteProviderConnectionsByProvider: vi.fn(),
  deleteProviderNode: vi.fn(),
  getCustomModels: vi.fn(async () => db.models),
  addCustomModel: vi.fn(async (m) => {
    if (db.failIds.has(m.id)) throw new Error("boom");
    db.models.push(m);
    return true;
  }),
  deleteCustomModel: vi.fn(),
}));

const nodesRoute = await import("../../src/app/api/provider-nodes/route.js");
const nodeRoute = await import("../../src/app/api/provider-nodes/[id]/route.js");
const customRoute = await import("../../src/app/api/models/custom/route.js");
const { isReservedPrefix, RESERVED_PREFIXES, prefixProblem, prefixFormatProblem, PREFIX_MAX_LENGTH } = await import("../../src/shared/utils/reservedPrefixes.js");
const { makePrefix } = await import("../../src/lib/endpointDetect.js");

const req = (body) => ({ json: async () => body });
const params = (id) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  db.nodes = []; db.connections = []; db.models = []; db.failIds = new Set();
});

describe("reserved prefixes", () => {
  it("covers built-in provider ids and aliases", () => {
    for (const p of ["kimi", "groq", "openai", "kmc", "xmtp"]) expect(isReservedPrefix(p)).toBe(true);
    expect(isReservedPrefix("Kimi")).toBe(true);
    expect(isReservedPrefix("my-ep")).toBe(false);
  });

  it("matches routing's reserved set: uiAlias-only names stay usable", async () => {
    const { default: REGISTRY } = await import("../../open-sse/providers/registry/index.js");
    const routed = new Set(["xmtp", "xiaomi-tokenplan"]);
    for (const e of REGISTRY) {
      routed.add(e.id);
      if (e.alias) routed.add(e.alias);
      for (const a of e.aliases || []) routed.add(a);
    }
    expect(RESERVED_PREFIXES).toEqual([...routed].map((n) => n.toLowerCase()).sort());
    // perplexity-agent's uiAlias "pa" and voyage-ai's "voyage" aren't routed.
    expect(isReservedPrefix("pa")).toBe(false);
    expect(isReservedPrefix("voyage")).toBe(false);
    // Routed aliases stay reserved.
    for (const p of ["ag", "bb", "cf"]) expect(isReservedPrefix(p)).toBe(true);
  });

  it("checks prefix format", () => {
    expect(prefixFormatProblem("my-ep2")).toBeNull();
    expect(prefixFormatProblem("My_Ep")).toMatch(/lowercase/);
    expect(prefixFormatProblem("a/b")).toMatch(/lowercase/);
    expect(prefixFormatProblem("a".repeat(PREFIX_MAX_LENGTH + 1))).toMatch(/at most/);
    expect(prefixProblem("Bad Prefix")).toMatch(/lowercase/);
  });

  it("makePrefix avoids them when passed as taken", () => {
    expect(makePrefix("Groq", RESERVED_PREFIXES)).not.toBe("groq");
    expect(isReservedPrefix(makePrefix("Groq", RESERVED_PREFIXES))).toBe(false);
  });

  it("flags a clash with another node but not with itself", () => {
    const nodes = [{ id: "a", prefix: "ep", name: "Ep" }];
    expect(prefixProblem("ep", { nodes })).toMatch(/already used by Ep/);
    expect(prefixProblem("ep", { nodes, selfId: "a" })).toBeNull();
  });
});

describe("POST /api/provider-nodes", () => {
  const body = { name: "My Kimi", prefix: "kimi", type: "openai-compatible", apiType: "chat", baseUrl: "https://x.example/v1" };

  it("rejects a built-in provider's name as prefix", async () => {
    const res = await nodesRoute.POST(req(body));
    expect(res.status).toBe(400);
    expect(res.body.field).toBe("prefix");
    expect(res.body.error).toMatch(/built-in/);
    expect(db.nodes).toHaveLength(0);
  });

  it("returns the existing node on a retried save instead of duplicating", async () => {
    const first = await nodesRoute.POST(req({ ...body, prefix: "mk" }));
    expect(first.status).toBe(201);
    const again = await nodesRoute.POST(req({ ...body, prefix: "mk", baseUrl: "https://x.example/v1/" }));
    expect(again.status).toBe(200);
    expect(again.body.node.id).toBe(first.body.node.id);
    expect(db.nodes).toHaveLength(1);
  });

  it.each([["My-EP"], ["my ep"], ["a/b"], ["x".repeat(40)]])("rejects malformed prefix %s with field prefix", async (prefix) => {
    const res = await nodesRoute.POST(req({ ...body, prefix }));
    expect(res.status).toBe(400);
    expect(res.body.field).toBe("prefix");
    expect(db.nodes).toHaveLength(0);
  });

  it("compares prefixes case-insensitively against legacy nodes", async () => {
    db.nodes = [{ id: "old", type: "openai-compatible", apiType: "chat", prefix: "MK", name: "Old", baseUrl: "https://old.example/v1" }];
    const res = await nodesRoute.POST(req({ ...body, prefix: "mk" }));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/already used by Old/);
  });

  it("rejects a prefix another endpoint already uses", async () => {
    await nodesRoute.POST(req({ ...body, prefix: "mk" }));
    const res = await nodesRoute.POST(req({ ...body, prefix: "mk", baseUrl: "https://other.example/v1" }));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/already used/);
  });
});

describe("PUT /api/provider-nodes/[id]", () => {
  const node = {
    id: "anthropic-compatible-1", type: "anthropic-compatible", name: "Ep", prefix: "ep", baseUrl: "https://x.example/v1",
    droppedBetas: ["a-flag", "b-flag"], modelRoutes: { "gpt-x": "openai-chat" },
  };
  const base = { name: "Ep", prefix: "ep", baseUrl: "https://x.example/v1" };

  beforeEach(() => {
    db.nodes = [{ ...node }];
    db.connections = [{ id: "c1", provider: node.id, providerSpecificData: { droppedBetas: ["c-flag"], proxyPoolId: "pp", modelRoutes: node.modelRoutes } }];
  });

  it("toggling one quirk keeps learned fields on node and keys", async () => {
    const res = await nodeRoute.PUT(req({ ...base, quirks: { maxCompletionTokens: true } }), params(node.id));
    expect(res.status).toBe(200);
    expect(res.body.node).toMatchObject({ maxCompletionTokens: true, droppedBetas: ["a-flag", "b-flag"], modelRoutes: { "gpt-x": "openai-chat" } });
    const psd = db.connections[0].providerSpecificData;
    expect(psd.maxCompletionTokens).toBe(true);
    expect(psd.proxyPoolId).toBe("pp");
    expect(psd.modelRoutes).toEqual({ "gpt-x": "openai-chat" });
    expect(psd.droppedBetas.sort()).toEqual(["a-flag", "b-flag", "c-flag"]);
  });

  it("removeDroppedBetas removes one flag from node and keys", async () => {
    await nodeRoute.PUT(req({ ...base, quirks: {}, removeDroppedBetas: ["a-flag"] }), params(node.id));
    expect(db.nodes[0].droppedBetas).toEqual(["b-flag"]);
    expect(db.connections[0].providerSpecificData.droppedBetas.sort()).toEqual(["b-flag", "c-flag"]);
  });

  it("rejects changing the prefix to a reserved one, allows keeping the current one", async () => {
    const bad = await nodeRoute.PUT(req({ ...base, prefix: "openai" }), params(node.id));
    expect(bad.status).toBe(400);
    expect(bad.body.field).toBe("prefix");
    const ok = await nodeRoute.PUT(req(base), params(node.id));
    expect(ok.status).toBe(200);
  });
});

describe("PUT prefix format", () => {
  const legacy = { id: "openai-compatible-chat-1", type: "openai-compatible", apiType: "chat", name: "Legacy", prefix: "My_Legacy", baseUrl: "https://x.example/v1" };
  const base = { name: "Legacy", apiType: "chat", baseUrl: "https://x.example/v1" };
  beforeEach(() => { db.nodes = [{ ...legacy }]; });

  it("lets a legacy node keep a prefix that predates the format rule", async () => {
    const res = await nodeRoute.PUT(req({ ...base, prefix: "My_Legacy" }), params(legacy.id));
    expect(res.status).toBe(200);
    expect(db.nodes[0].prefix).toBe("My_Legacy");
  });

  it("rejects changing to a malformed prefix", async () => {
    const res = await nodeRoute.PUT(req({ ...base, prefix: "Other_One" }), params(legacy.id));
    expect(res.status).toBe(400);
    expect(res.body.field).toBe("prefix");
  });

  it("allows moving a legacy prefix to a valid one", async () => {
    const res = await nodeRoute.PUT(req({ ...base, prefix: "my-legacy" }), params(legacy.id));
    expect(res.status).toBe(200);
    expect(db.nodes[0].prefix).toBe("my-legacy");
  });
});

describe("POST /api/models/custom (bulk)", () => {
  it("accepts exactly 1000 models and rejects 1001 (the modal chunks at 1000)", async () => {
    const ids = Array.from({ length: 1001 }, (_, i) => `m${i}`);
    const over = await customRoute.POST(req({ providerAlias: "n1", models: ids }));
    expect(over.status).toBe(400);
    expect(db.models).toHaveLength(0);
    const ok = await customRoute.POST(req({ providerAlias: "n1", models: ids.slice(0, 1000) }));
    expect(ok.status).toBe(200);
    expect(ok.body.added).toHaveLength(1000);
  });

  it("adds many and reports failures", async () => {
    db.failIds.add("bad");
    const res = await customRoute.POST(req({ providerAlias: "n1", models: ["a", { id: "b" }, "bad", ""] }));
    expect(res.status).toBe(200);
    expect(res.body.added).toEqual(["a", "b"]);
    expect(res.body.failed.map((f) => f.id)).toEqual(["bad", ""]);
    expect(res.body.success).toBe(false);
  });

  it("still accepts a single model", async () => {
    const res = await customRoute.POST(req({ providerAlias: "n1", id: "solo" }));
    expect(res.body.success).toBe(true);
    expect(db.models.map((m) => m.id)).toEqual(["solo"]);
  });
});
