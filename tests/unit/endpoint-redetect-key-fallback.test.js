// Re-detect "model check" must try the active keys in turn, like inference
// does: a dead-but-still-on key at the front, or a pool where every key has its
// own URL, must not make a working endpoint report "the key was rejected".
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
  redetectDiff: vi.fn(),
  savedSettingsFetch: vi.fn(),
  signal: null,
  sent: [],
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
  // Not the real 45s, so the test proves the route uses the export.
  DETECT_DEADLINE_MS: 40_000,
  detectEndpoint: mocks.detectEndpoint,
  // An http(s) URL or null, as the real normalizeUrl answers.
  normalizeUrl: (u) => (typeof u === "string" && /^https?:\/\/[^/\s]+/.test(u) ? u.replace(/\/+$/, "") : null),
  outdatedModels: () => [],
}));

vi.mock("@/lib/endpointImpersonate.js", () => ({ retryAsClient: mocks.retryAsClient }));
vi.mock("@/lib/endpointCatalog.js", () => ({ getEndpointCatalog: mocks.getEndpointCatalog }));
vi.mock("@/lib/probeFetch.js", () => ({ makeProbeFetch: mocks.makeProbeFetch }));
vi.mock("@/lib/endpointRequestLog.js", () => ({ isCustomEndpoint: mocks.isCustomEndpoint }));

vi.mock("@/app/api/provider-nodes/detect/ndjson.js", () => ({
  guardTarget: mocks.guardTarget,
  // The real respond(), minus the stream: progress events go to `sent`, and the
  // test may abort the signal.
  respond: async (_request, _label, work) => {
    const ctl = new AbortController();
    mocks.signal = ctl;
    const result = await work(ctl.signal, (e) => mocks.sent.push(e));
    return new Response(JSON.stringify(result), { status: 200, headers: { "Content-Type": "application/json" } });
  },
}));

// Same file the route reaches via "./diff.js"; mocked because the real diff
// pulls buildRoutes() from the (here-mocked) detect module. The real diff's
// scoping is tested in endpoint-redetect-diff.test.js.
vi.mock("@/app/api/providers/[id]/redetect/diff.js", () => ({
  savedProtocol: () => "openai-chat",
  savedSettingsFetch: mocks.savedSettingsFetch,
  redetectDiff: mocks.redetectDiff,
}));

const { POST } = await import("@/app/api/providers/[id]/redetect/route.ts");

const rejected = { ok: false, failure: "key", error: "The key was rejected.", steps: [] };
const down = { ok: false, failure: "down", error: "The endpoint didn't answer.", steps: [] };
const works = { ok: true, steps: [], protocol: "openai-chat", baseUrl: "https://api.acme.dev/v1", models: ["m1"], modelsSource: "models", quirks: {} };
// Passed the free probes, then refused once models were asked about.
const refusedLater = { ...works, models: [], authRejected: true };

const req = () => new Request("https://dash.local/api/providers/ep1/redetect?part=models", { method: "POST" });
const call = () => POST(req(), { params: Promise.resolve({ id: "ep1" }) });
const json = () => call().then((r) => r.json());
const keysUsed = () => mocks.detectEndpoint.mock.calls.map((c) => c[0].apiKey);
const urlsUsed = () => mocks.detectEndpoint.mock.calls.map((c) => c[0].url);

const conns = (...keys) => keys.map((apiKey, i) => ({ id: `c${i}`, isActive: true, apiKey }));
// Keys that each carry their own URL (one account per key), as Add key saves them.
const ownConns = (...keys) => keys.map((apiKey, i) => ({ id: `o${i}`, isActive: true, apiKey,
  providerSpecificData: { ownBaseUrl: true, baseUrl: `https://acct-${apiKey}.acme.dev/v1` } }));

let verdict;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.sent = [];
  mocks.isCustomEndpoint.mockReturnValue(true);
  mocks.getProviderNodeById.mockResolvedValue({ id: "ep1", type: "openai-compatible", apiType: "chat", baseUrl: "https://api.acme.dev/v1" });
  mocks.getCustomModels.mockResolvedValue([]);
  mocks.getEndpointCatalog.mockResolvedValue({});
  mocks.makeProbeFetch.mockReturnValue(() => Promise.resolve(new Response("{}")));
  mocks.guardTarget.mockResolvedValue({ remote: false });
  mocks.retryAsClient.mockImplementation((first) => Promise.resolve(first));
  // Tags the fetch with the key it was built for, so tests can see which key
  // the saved auth settings were applied with.
  mocks.savedSettingsFetch.mockImplementation((_f, _node, key) => Object.assign(() => {}, { forKey: key }));
  mocks.redetectDiff.mockImplementation((_node, _current, r, _outdated, _part, opts = {}) => r.ok
    ? { ok: true, protocol: null, baseUrl: null, addModels: r.models, removeModels: [], outdatedModels: [], quirks: {}, modelsNote: null, changes: r.models.length, keyScoped: !!opts.keyScoped }
    : { ok: false, error: r.error, protocol: null, baseUrl: null, addModels: [], removeModels: [], outdatedModels: [], quirks: {}, modelsNote: null, changes: 0 });
  verdict = {};
  mocks.detectEndpoint.mockImplementation(({ apiKey }) => Promise.resolve(verdict[apiKey] ?? rejected));
});

describe("re-detect model check: keys on the endpoint's URL", () => {
  it("falls through a rejected key to the next one, with that key's saved auth settings", async () => {
    mocks.getProviderConnections.mockResolvedValue(conns("dead", "good"));
    verdict.good = works;
    expect(await json()).toMatchObject({ ok: true, usedKey: true });
    expect(keysUsed()).toEqual(["dead", "good"]);
    expect(mocks.detectEndpoint.mock.calls.map((c) => c[0].fetchFn.forKey)).toEqual(["dead", "good"]);
  });

  it("falls through a key refused only once models were asked about", async () => {
    mocks.getProviderConnections.mockResolvedValue(conns("dead", "good"));
    verdict.dead = refusedLater;
    verdict.good = works;
    expect(await json()).toMatchObject({ ok: true, addModels: ["m1"] });
    expect(keysUsed()).toEqual(["dead", "good"]);
  });

  it("stops at the first key that works", async () => {
    mocks.getProviderConnections.mockResolvedValue(conns("good", "spare"));
    verdict.good = works;
    expect((await json()).ok).toBe(true);
    expect(keysUsed()).toEqual(["good"]);
  });

  it("doesn't try another key when the endpoint itself fails, even with own-URL keys behind it", async () => {
    mocks.getProviderConnections.mockResolvedValue([...conns("k1", "k2"), ...ownConns("o")]);
    verdict.k1 = down;
    expect(await json()).toMatchObject({ ok: false, error: down.error });
    expect(keysUsed()).toEqual(["k1"]);
  });

  it("says how many keys it tried when all are refused, capped at 5", async () => {
    mocks.getProviderConnections.mockResolvedValue(conns("a", "b", "c", "d", "e", "f"));
    expect(await json()).toMatchObject({ ok: false, error: "None of the 5 keys it tried was accepted", usedKey: true });
    expect(keysUsed()).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("reports a late refusal of the only key as a refusal, not as nothing changed", async () => {
    mocks.getProviderConnections.mockResolvedValue(conns("dead"));
    verdict.dead = refusedLater;
    expect(await json()).toMatchObject({ ok: false, error: "The key was rejected" });
  });

  it("names a late refusal of the first key when a later one fails otherwise", async () => {
    mocks.getProviderConnections.mockResolvedValue([...conns("dead"), ...ownConns("o1")]);
    verdict.dead = refusedLater;
    verdict.o1 = down;
    expect(await json()).toMatchObject({ ok: false, error: "None of the 2 keys it tried got through. The first: The key was rejected" });
  });

  it("doesn't spend an attempt on a key with no credential", async () => {
    mocks.getProviderConnections.mockResolvedValue([...conns("", "", "", "", ""), ...conns("good")]);
    verdict.good = works;
    expect((await json()).ok).toBe(true);
    expect(keysUsed()).toEqual(["good"]);
  });

  it("still runs once with no key when the endpoint has no keys", async () => {
    mocks.getProviderConnections.mockResolvedValue([]);
    verdict[""] = works;
    expect(await json()).toMatchObject({ ok: true, usedKey: false });
    expect(mocks.detectEndpoint).toHaveBeenCalledTimes(1);
  });
});

describe("re-detect model check: keys with their own URL", () => {
  it("asks each key at its own URL instead of probing the endpoint with no key", async () => {
    mocks.getProviderConnections.mockResolvedValue([{ id: "off", isActive: false, apiKey: "shared-off" }, ...ownConns("dead", "good")]);
    verdict.good = works;
    expect(await json()).toMatchObject({ ok: true, usedKey: true, viaKeyUrl: true, keyScoped: true });
    expect(keysUsed()).toEqual(["dead", "good"]);
    expect(urlsUsed()).toEqual(["https://acct-dead.acme.dev/v1", "https://acct-good.acme.dev/v1"]);
  });

  it("moves on when a key's own server is down: it says nothing about the next account", async () => {
    mocks.getProviderConnections.mockResolvedValue(ownConns("k1", "k2"));
    verdict.k1 = down;
    verdict.k2 = works;
    expect((await json()).ok).toBe(true);
    expect(keysUsed()).toEqual(["k1", "k2"]);
  });

  it("reports the first key's verdict, and that more were tried, when none gets through", async () => {
    mocks.getProviderConnections.mockResolvedValue([...conns("shared"), ...ownConns("o1")]);
    verdict.o1 = down;
    const body = await json();
    expect(body).toMatchObject({ ok: false, error: "None of the 2 keys it tried got through. The first: The key was rejected" });
    expect(body.viaKeyUrl).toBeUndefined();
  });

  it("tries keys on the endpoint's URL before keys with their own, unscoped", async () => {
    mocks.getProviderConnections.mockResolvedValue([...ownConns("own"), ...conns("shared")]);
    verdict.shared = works;
    const body = await json();
    expect(keysUsed()).toEqual(["shared"]);
    expect(body).toMatchObject({ keyScoped: false });
    expect(body.viaKeyUrl).toBeUndefined();
  });

  it("skips a key whose own URL isn't a URL", async () => {
    mocks.getProviderConnections.mockResolvedValue([
      { id: "bad", isActive: true, apiKey: "bad", providerSpecificData: { ownBaseUrl: true, baseUrl: "not a url" } }, ...ownConns("good")]);
    verdict.good = works;
    expect((await json()).ok).toBe(true);
    expect(keysUsed()).toEqual(["good"]);
  });

  it("says so, and probes nothing, when no active key has a usable URL", async () => {
    mocks.getProviderConnections.mockResolvedValue([{ id: "bad", isActive: true, apiKey: "bad", providerSpecificData: { ownBaseUrl: true, baseUrl: "" } }]);
    const res = await call();
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/valid URL/);
    expect(mocks.detectEndpoint).not.toHaveBeenCalled();
  });

  it("sends the client-identity retry to the key's own URL with the same key", async () => {
    mocks.getProviderConnections.mockResolvedValue(ownConns("gated"));
    verdict.gated = { ok: false, failure: "gated", clientGated: true, error: "Only works as a known client.", steps: [] };
    mocks.retryAsClient.mockImplementation(async (first, opts) => {
      expect(opts).toMatchObject({ url: "https://acct-gated.acme.dev/v1", apiKey: "gated" });
      return opts.detect(() => {});
    });
    await json();
    expect(urlsUsed()).toEqual(["https://acct-gated.acme.dev/v1", "https://acct-gated.acme.dev/v1"]);
    expect(keysUsed()).toEqual(["gated", "gated"]);
  });
});

describe("re-detect model check: one run across keys", () => {
  it("shares one time budget across keys, so the page's 60s wait isn't outrun", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      mocks.getProviderConnections.mockResolvedValue(conns("a", "b", "c", "d", "e"));
      // Every rejected key takes 20s to answer.
      mocks.detectEndpoint.mockImplementation(() => { vi.setSystemTime(Date.now() + 20_000); return Promise.resolve(rejected); });
      await json();
      expect(mocks.detectEndpoint.mock.calls.map((c) => c[0].deadlineMs)).toEqual([40_000, 20_000]);
    } finally { vi.useRealTimers(); }
  });

  it("stops trying keys once the user cancels", async () => {
    mocks.getProviderConnections.mockResolvedValue(conns("a", "b", "c"));
    mocks.detectEndpoint.mockImplementation(() => { mocks.signal.abort(); return Promise.resolve(rejected); });
    await json();
    expect(keysUsed()).toEqual(["a"]);
  });

  it("numbers requests on from one key's run to the next", async () => {
    mocks.getProviderConnections.mockResolvedValue(conns("a", "b"));
    verdict.b = works;
    mocks.detectEndpoint.mockImplementation(({ apiKey, onProgress }) => {
      onProgress({ type: "request", n: 1, sent: 1 });
      onProgress({ type: "request", n: 2, sent: 2 });
      return Promise.resolve(verdict[apiKey] ?? rejected);
    });
    await json();
    expect(mocks.sent.map((e) => [e.n, e.sent])).toEqual([[1, 1], [2, 2], [3, 3], [4, 4]]);
  });
});
