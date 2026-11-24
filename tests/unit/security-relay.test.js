// Deployed relays (Cloudflare, Vercel, Deno) answer only this gateway: the
// generated code checks relay_key, the stored pool URL carries it through
// proxyFetch, a redeploy under the same name updates the pool, and the key is
// redacted from chatCore's log line.
import { describe, it, expect, vi, beforeEach } from "vitest";

// proxyFetch keeps the fetch it found at load as its direct fetch: give it this one.
const directFetch = vi.hoisted(() => {
  const fn = vi.fn(async () => new Response("{}", { status: 200 }));
  globalThis.fetch = fn;
  return fn;
});

const state = vi.hoisted(() => ({ pools: [] }));
vi.mock("next/server", () => ({ NextResponse: { json: (body, init) => ({ status: init?.status || 200, body }) } }));
vi.mock("@/models", () => ({
  getProxyPools: vi.fn(async () => state.pools),
  getProxyPoolById: vi.fn(async (id) => state.pools.find((p) => p.id === id) || null),
  createProxyPool: vi.fn(async (p) => { const pool = { id: `pool-${state.pools.length + 1}`, ...p }; state.pools.push(pool); return pool; }),
  updateProxyPool: vi.fn(async (id, data) => {
    const i = state.pools.findIndex((p) => p.id === id);
    state.pools[i] = { ...state.pools[i], ...data };
    return state.pools[i];
  }),
}));

const { executeMock } = vi.hoisted(() => ({ executeMock: vi.fn() }));
vi.mock("../../open-sse/executors/index.js", () => ({ getExecutor: vi.fn(() => ({ execute: executeMock, noAuth: true })) }));
vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: vi.fn(async () => ({ logClientRawRequest: vi.fn(), logRawRequest: vi.fn(), logTargetRequest: vi.fn(), logError: vi.fn() })),
}));
vi.mock("../../open-sse/translator/concerns/prefetch.js", () => ({ prefetchRemoteImages: vi.fn(async () => 0) }));
vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(), appendRequestLog: vi.fn(() => Promise.resolve()),
  saveRequestDetail: vi.fn(() => Promise.resolve()), saveRequestUsage: vi.fn(() => Promise.resolve()),
}));

import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";
import { resolveConnectionProxyConfig } from "../../src/lib/network/connectionProxy.js";
import { withRelayKey, newRelayKey } from "../../src/lib/network/relayKey.js";

const cloudflareDeploy = await import("../../src/app/api/proxy-pools/cloudflare-deploy/route.js");
const vercelDeploy = await import("../../src/app/api/proxy-pools/vercel-deploy/route.js");
const denoDeploy = await import("../../src/app/api/proxy-pools/deno-deploy/route.js");

const req = (body) => ({ json: async () => body, headers: new Headers() });
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

// Run generated relay code: `export default` / `export const` dropped, the
// handler handed back. Deno's code registers itself through Deno.serve.
function loadHandler(code, kind) {
  if (kind === "deno") {
    let handler;
    new Function("Deno", code)({ serve: (fn) => { handler = fn; } });
    return handler;
  }
  const body = code.replace(/export const config[^\n]*\n/, "").replace("export default async function handler", "return async function handler").replace("export default {", "return {");
  const out = new Function(body)();
  return kind === "cloudflare" ? (request) => out.fetch(request, {}, {}) : out;
}

async function expectKeyEnforced(code, kind) {
  const handler = loadHandler(code, kind);
  const keyed = state.pools.at(-1).proxyUrl;
  const call = (url) => handler(new Request(url));
  expect((await call("https://relay.example/")).status).toBe(403);
  expect((await call(`https://relay.example/?relay_key=${"x".repeat(32)}`)).status).toBe(403);
  // Past the key check, the relay asks for its target header: 400, not 403.
  expect((await call(keyed)).status).toBe(400);
}

beforeEach(() => {
  state.pools = [];
  directFetch.mockReset();
});

describe("relay templates", () => {
  it("Vercel: the deployed function refuses requests without the pool's key", async () => {
    let code = "";
    directFetch.mockImplementation(async (url, init) => {
      if (String(url).endsWith("/v13/deployments") && init?.method === "POST") {
        code = JSON.parse(init.body).files.find((f) => f.file === "api/relay.js").data;
        return json({ id: "dpl_1", projectId: "prj_1" });
      }
      if (String(url).includes("/v13/deployments/dpl_1")) return json({ readyState: "READY", url: "relay-x-abc.vercel.app" });
      return json({});
    });
    const res = await vercelDeploy.POST(req({ vercelToken: "t", projectName: "relay-x" }));
    expect(res.status).toBe(201);
    expect(new URL(state.pools[0].proxyUrl).searchParams.get("relay_key")).toMatch(/^[\w-]{32}$/);
    await expectKeyEnforced(code, "vercel");
  });

  it("Deno: the deployed app refuses requests without the pool's key", async () => {
    let code = "";
    directFetch.mockImplementation(async (url, init) => {
      if (String(url).endsWith("/v2/apps") && init?.method === "POST") return json({ id: "app_1" });
      if (String(url).endsWith("/apps/app_1/deploy")) {
        code = JSON.parse(init.body).assets["main.ts"].content;
        return json({ id: "rev_1", status: "succeeded" });
      }
      return json({});
    });
    const res = await denoDeploy.POST(req({ denoToken: "t", orgDomain: "acme.deno.net", projectName: "relay-d" }));
    expect(res.status).toBe(201);
    await expectKeyEnforced(code, "deno");
  });

  it("Cloudflare: the worker refuses requests without the key, and a redeploy under the same name updates the pool", async () => {
    let code = "";
    directFetch.mockImplementation(async (url, init) => {
      if (init?.body instanceof FormData) code = await init.body.get("index.js").text();
      return json({ success: true, result: { subdomain: "acct" } });
    });
    const first = await cloudflareDeploy.POST(req({ accountId: "a", apiToken: "t", projectName: "relay-c" }));
    expect(first.status).toBe(201);
    await expectKeyEnforced(code, "cloudflare");
    const firstKey = new URL(state.pools[0].proxyUrl).searchParams.get("relay_key");
    state.pools[0].isActive = false; // switched off by the operator: stays off

    const again = await cloudflareDeploy.POST(req({ accountId: "a", apiToken: "t", projectName: "relay-c" }));
    expect(again.status).toBe(200);
    expect(again.body.updated).toBe(true);
    expect(state.pools).toHaveLength(1);
    const secondKey = new URL(state.pools[0].proxyUrl).searchParams.get("relay_key");
    expect(secondKey).not.toBe(firstKey);
    expect(state.pools[0].isActive).toBe(false);
    expect(code).toContain(JSON.stringify(secondKey));
  });
});

describe("relay key in use", () => {
  it("refuses a relay name or Deno organization that would move the pool URL to another host", async () => {
    for (const projectName of ["localhost#", "relay/x", "a?b", "x.y", "-x"]) {
      const res = await cloudflareDeploy.POST(req({ accountId: "a", apiToken: "t", projectName }));
      expect(res.status, projectName).toBe(400);
    }
    const deno = await denoDeploy.POST(req({ denoToken: "t", orgDomain: "localhost:1/?.deno.net", projectName: "relay-d" }));
    expect(deno.status).toBe(400);
    expect(directFetch).not.toHaveBeenCalled();
    expect(state.pools).toHaveLength(0);
  });

  it("survives the pool → connection proxy → proxyFetch path and isn't forwarded to the upstream", async () => {
    const key = newRelayKey();
    state.pools = [{ id: "p1", type: "cloudflare", isActive: true, proxyUrl: withRelayKey("https://relay-c.acct.workers.dev", key) }];
    const resolved = await resolveConnectionProxyConfig({ proxyPoolId: "p1" });
    directFetch.mockResolvedValue(new Response("{}", { status: 200 }));
    await proxyAwareFetch("https://api.example.com/v1/chat/completions?x=1", { method: "POST", headers: { authorization: "Bearer sk" } }, { vercelRelayUrl: resolved.vercelRelayUrl });
    const [url, init] = directFetch.mock.calls[0];
    expect(new URL(url).searchParams.get("relay_key")).toBe(key);
    expect(init.headers["x-relay-target"]).toBe("https://api.example.com");
    expect(init.headers["x-relay-path"]).toBe("/v1/chat/completions?x=1");
  });

  it("chatCore logs the relay URL with the key redacted", async () => {
    const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");
    const key = newRelayKey();
    const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    executeMock.mockResolvedValue({ response: json({ error: { message: "down" } }, 503), url: "https://upstream.example.test", headers: {}, transformedBody: {} });
    const body = { model: "gpt-4o", messages: [{ role: "user", content: "Hi" }] };
    await handleChatCore({
      body,
      modelInfo: { provider: "openai", model: "gpt-4o" },
      credentials: { apiKey: "k", providerSpecificData: { vercelRelayUrl: withRelayKey("https://relay-c.acct.workers.dev", key) } },
      clientRawRequest: { endpoint: "/v1/chat/completions", body, headers: {} },
      connectionId: "conn-1",
      log,
    });
    const line = log.info.mock.calls.map((c) => c.join(" ")).find((l) => l.includes("vercel-relay="));
    expect(line).toBeDefined();
    expect(line).toContain("relay_key=[REDACTED]");
    expect(line).not.toContain(key);
  }, 30000);
});
