// Re-detect "model check" must try the active keys in turn, like inference
// does, so one dead-but-still-on key sitting at the front of the pool can't
// make a working endpoint report "the key was rejected" while healthy keys
// behind it are never tried.
import { describe, it, expect, beforeEach, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  getCustomModels: vi.fn(),
  getProviderNodeById: vi.fn(),
  detectEndpoint: vi.fn(),
  retryAsClient: vi.fn(),
  getEndpointCatalog: vi.fn(),
  makeProbeFetch: vi.fn(),
  isCustomEndpoint: vi.fn(),
  guardTarget: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getProviderConnections: mocks.getProviderConnections,
  getCustomModels: mocks.getCustomModels,
  getProviderNodeById: mocks.getProviderNodeById,
  // Unused by POST, present so the named imports resolve.
  addCustomModel: vi.fn(),
  deleteCustomModel: vi.fn(),
  updateProviderConnection: vi.fn(),
  updateProviderNode: vi.fn(),
}));

vi.mock("@/lib/endpointDetect.js", () => ({
  detectEndpoint: mocks.detectEndpoint,
  normalizeUrl: (u) => u,
  outdatedModels: () => [],
}));

vi.mock("@/lib/endpointImpersonate.js", () => ({
  // No client-identity retry in these cases: hand back the first run as-is.
  retryAsClient: mocks.retryAsClient,
}));

vi.mock("@/lib/endpointCatalog.js", () => ({ getEndpointCatalog: mocks.getEndpointCatalog }));
vi.mock("@/lib/probeFetch.js", () => ({ makeProbeFetch: mocks.makeProbeFetch }));
vi.mock("@/lib/endpointRequestLog.js", () => ({ isCustomEndpoint: mocks.isCustomEndpoint }));

vi.mock("@/app/api/provider-nodes/detect/ndjson.js", () => ({
  guardTarget: mocks.guardTarget,
  // The non-NDJSON branch of the real respond(): run the work and JSON it.
  respond: async (_request, _label, work) => {
    const result = await work(new AbortController().signal, () => {});
    return new Response(JSON.stringify(result), { status: 200, headers: { "Content-Type": "application/json" } });
  },
}));

// Same file the route reaches via "./diff.js"; mocked because the real diff
// pulls buildRoutes() from the (here-mocked) detect module.
vi.mock("@/app/api/providers/[id]/redetect/diff.js", () => ({
  savedProtocol: () => "openai-chat",
  savedSettingsFetch: (f) => f,
  // Thin passthrough so the test can read which run's result reached the diff.
  // A working run proposes every kind of change, so scoping can be checked.
  redetectDiff: (_node, _current, r) => r.ok
    ? { ok: true, protocol: null, baseUrl: { from: "https://api.acme.dev/v1", to: r.baseUrl }, addModels: ["new"], removeModels: ["gone"],
      outdatedModels: [], quirks: { maxCompletionTokens: true, modelRoutes: { new: "openai-responses" } }, modelsNote: null, changes: 5 }
    : { ok: false, error: r.error ?? null, protocol: null, baseUrl: null, addModels: [], removeModels: [], outdatedModels: [], quirks: {}, modelsNote: null, changes: 0 },
}));

const { POST } = await import("@/app/api/providers/[id]/redetect/route.ts");

const rejected = { ok: false, failure: "key", error: "The key was rejected.", steps: [] };
const down = { ok: false, failure: "down", error: "The endpoint didn't answer.", steps: [] };
const works = { ok: true, error: null, steps: [], protocol: "openai-chat", baseUrl: "https://api.acme.dev/v1", models: ["m1"], modelsSource: "models", quirks: {} };

const req = () => new Request("https://dash.local/api/providers/ep1/redetect?part=models", { method: "POST" });
const call = () => POST(req(), { params: Promise.resolve({ id: "ep1" }) }).then((r) => r.json());
const keysUsed = () => mocks.detectEndpoint.mock.calls.map((c) => c[0].apiKey);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.isCustomEndpoint.mockReturnValue(true);
  mocks.getProviderNodeById.mockResolvedValue({ id: "ep1", type: "openai-compatible", apiType: "chat", baseUrl: "https://api.acme.dev/v1" });
  mocks.getCustomModels.mockResolvedValue([]);
  mocks.getEndpointCatalog.mockResolvedValue({});
  mocks.makeProbeFetch.mockReturnValue(() => Promise.resolve(new Response("{}")));
  mocks.guardTarget.mockResolvedValue({ remote: false });
  mocks.retryAsClient.mockImplementation((first) => Promise.resolve(first));
  // Each key gets its verdict from this map, keyed by the apiKey passed in.
  const verdict = {};
  mocks.detectEndpoint.mockImplementation(({ apiKey }) => Promise.resolve(verdict[apiKey] ?? rejected));
  mocks._verdict = verdict;
});

const conns = (...keys) => keys.map((apiKey, i) => ({ id: `c${i}`, isActive: true, apiKey }));
// Keys that each carry their own URL (one account per key), as Add key saves them.
const ownConns = (...keys) => keys.map((apiKey, i) => ({ id: `o${i}`, isActive: true, apiKey,
  providerSpecificData: { ownBaseUrl: true, baseUrl: `https://acct-${apiKey}.acme.dev/v1` } }));
const urlsUsed = () => mocks.detectEndpoint.mock.calls.map((c) => c[0].url);

describe("re-detect model check on keys with their own URL", () => {
  it("asks each key at its own URL instead of probing the endpoint with no key", async () => {
    mocks.getProviderConnections.mockResolvedValue([{ id: "off", isActive: false, apiKey: "shared-off" }, ...ownConns("dead", "good")]);
    mocks._verdict.good = works;
    const body = await call();
    expect(body).toMatchObject({ ok: true, usedKey: true, viaKeyUrl: true });
    expect(keysUsed()).toEqual(["dead", "good"]);
    expect(urlsUsed()).toEqual(["https://acct-dead.acme.dev/v1", "https://acct-good.acme.dev/v1"]);
  });

  it("moves on when a key's own server is down: it says nothing about the next account", async () => {
    mocks.getProviderConnections.mockResolvedValue(ownConns("k1", "k2"));
    mocks._verdict.k1 = down;
    mocks._verdict.k2 = works;
    expect((await call()).ok).toBe(true);
    expect(keysUsed()).toEqual(["k1", "k2"]);
  });

  it("tries keys on the endpoint's URL before keys with their own", async () => {
    mocks.getProviderConnections.mockResolvedValue([...ownConns("own"), ...conns("shared")]);
    mocks._verdict.shared = works;
    const body = await call();
    expect(keysUsed()).toEqual(["shared"]);
    expect(body.viaKeyUrl).toBeUndefined();
    expect(body.removeModels).toEqual(["gone"]);
  });

  it("never offers one account's URL, missing models or routes as the whole endpoint's", async () => {
    mocks.getProviderConnections.mockResolvedValue(ownConns("good"));
    mocks._verdict.good = works;
    const body = await call();
    expect(body).toMatchObject({ ok: true, baseUrl: null, removeModels: [], addModels: ["new"], quirks: { maxCompletionTokens: true }, changes: 2 });
    expect(body.quirks.modelRoutes).toBeUndefined();
  });

  it("doesn't spend an attempt on a key with no credential", async () => {
    mocks.getProviderConnections.mockResolvedValue([...conns("", "", "", "", ""), ...conns("good")]);
    mocks._verdict.good = works;
    expect((await call()).ok).toBe(true);
    expect(keysUsed()).toEqual(["good"]);
  });

  it("shares one time budget across keys, so the page's 60s wait isn't outrun", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      mocks.getProviderConnections.mockResolvedValue(conns("a", "b", "c", "d", "e"));
      // Every rejected key takes 20s to answer.
      mocks.detectEndpoint.mockImplementation(({ deadlineMs }) => { vi.setSystemTime(Date.now() + 20_000); return Promise.resolve({ ...rejected, deadlineMs }); });
      await call();
      const budgets = mocks.detectEndpoint.mock.calls.map((c) => c[0].deadlineMs);
      expect(budgets).toEqual([45_000, 25_000, 5_000]);
    } finally { vi.useRealTimers(); }
  });

  it("skips a key whose own URL the SSRF guard refuses", async () => {
    const { NextResponse } = await import("next/server");
    mocks.guardTarget.mockImplementation((_r, url) => Promise.resolve(url.includes("acct-bad") ? NextResponse.json({ ok: false }, { status: 400 }) : { remote: true }));
    mocks.getProviderConnections.mockResolvedValue(ownConns("bad", "good"));
    mocks._verdict.good = works;
    expect((await call()).ok).toBe(true);
    expect(keysUsed()).toEqual(["good"]);
  });
});

describe("re-detect model check key fallback", () => {
  it("falls through a rejected key to the next one and reports that endpoint works", async () => {
    mocks.getProviderConnections.mockResolvedValue(conns("dead", "good"));
    mocks._verdict.good = works;
    const body = await call();
    expect(body).toMatchObject({ ok: true, usedKey: true });
    expect(keysUsed()).toEqual(["dead", "good"]);
  });

  it("stops at the first key that works and tries no more", async () => {
    mocks.getProviderConnections.mockResolvedValue(conns("good", "spare"));
    mocks._verdict.good = works;
    const body = await call();
    expect(body.ok).toBe(true);
    expect(keysUsed()).toEqual(["good"]);
  });

  it("does not try another key when the failure is the endpoint's, not the key's", async () => {
    mocks.getProviderConnections.mockResolvedValue(conns("k1", "k2"));
    mocks._verdict.k1 = down;
    const body = await call();
    expect(body).toMatchObject({ ok: false, error: down.error });
    expect(keysUsed()).toEqual(["k1"]);
  });

  it("reports the rejection only after every active key is rejected, capped at 5 tries", async () => {
    mocks.getProviderConnections.mockResolvedValue(conns("a", "b", "c", "d", "e", "f"));
    const body = await call();
    expect(body).toMatchObject({ ok: false, error: rejected.error });
    expect(mocks.detectEndpoint).toHaveBeenCalledTimes(5);
    expect(keysUsed()).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("still runs once with no key when the endpoint has no active keys", async () => {
    mocks.getProviderConnections.mockResolvedValue([]);
    mocks._verdict[""] = works;
    const body = await call();
    expect(body).toMatchObject({ ok: true, usedKey: false });
    expect(mocks.detectEndpoint).toHaveBeenCalledTimes(1);
  });
});
