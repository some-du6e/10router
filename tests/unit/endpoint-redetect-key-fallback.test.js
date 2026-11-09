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
  DETECT_DEADLINE_MS: 50_000,
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
  // As the real one answers.
  savedProtocol: (n) => (n.type === "anthropic-compatible" ? "anthropic" : n.apiType === "responses" ? "openai-responses" : "openai-chat"),
  savedSettingsFetch: mocks.savedSettingsFetch,
  redetectDiff: mocks.redetectDiff,
}));

const { POST } = await import("@/app/api/providers/[id]/redetect/route.ts");

// Worded unlike the route's own "The key was rejected", so tests can tell them apart.
// keyVerdict is detection's own call on the key (endpoint-detect-key-verdict.test.js).
const rejected = { ok: false, failure: "key", keyVerdict: "refused", error: "Wrong key.", steps: [] };
const down = { ok: false, failure: "down", keyVerdict: null, error: "The endpoint didn't answer.", steps: [] };
const works = { ok: true, keyVerdict: "accepted", steps: [], protocol: "openai-chat", baseUrl: "https://api.acme.dev/v1", models: ["m1"], modelsSource: "models", quirks: {} };
// Passed the free probes with no /models list, then the model probes stopped on the key.
const unlisted = { ...works, models: [], modelsSource: "none" };
const refusedLater = { ...unlisted, authRejected: true, stopReason: "auth", keyVerdict: "refused" };
// A key limited to models outside the ones asked about: it works.
const limitedKey = { ...unlisted, authRejected: true, stopReason: "denied" };
const rateLimit = { ok: false, failure: "rate", keyVerdict: "rate-limited", error: "The endpoint is rate-limiting requests.", steps: [] };
// The free probes passed, then the model probes kept getting 429s and found nothing.
const modelsRateLimited = { ...unlisted, stopReason: "rate", keyVerdict: "rate-limited", partialReason: "The endpoint kept rate-limiting, so some models weren't checked." };
// Only GET /models refused the key (an admin-only list); nothing says the key is bad.
const listOnlyRefused = { ...unlisted, authRejected: true, stopReason: null };
// The model probes were cut short (time, 5xx) before they told anything.
const cutShort = { ...unlisted, stopReason: "deadline", keyVerdict: null, partialReason: "Detection ran out of time, so some models weren't checked." };

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
    const body = await json();
    expect(body).toMatchObject({ ok: false, error: "None of the 5 keys it tried was accepted", usedKey: true });
    expect(keysUsed()).toEqual(["a", "b", "c", "d", "e"]);
    // "Tried before the one that got through" only when one did.
    expect(body.keysFailedFirst).toBeUndefined();
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
    expect(await json()).toMatchObject({ ok: false, error: "None of the 2 keys it tried worked. The first: The key was rejected" });
  });

  it("doesn't blame a key that only GET /models refused, and tries no other", async () => {
    mocks.getProviderConnections.mockResolvedValue(conns("fine", "spare"));
    verdict.fine = listOnlyRefused;
    expect((await json()).ok).toBe(true);
    expect(keysUsed()).toEqual(["fine"]);
  });

  it("says how many keys it tried when some were refused late and the rest outright", async () => {
    mocks.getProviderConnections.mockResolvedValue(conns("late", "bad"));
    verdict.late = refusedLater;
    expect(await json()).toMatchObject({ ok: false, error: "None of the 2 keys it tried was accepted" });
  });

  it("doesn't call a key limited to other models rejected", async () => {
    mocks.getProviderConnections.mockResolvedValue(conns("limited", "spare"));
    verdict.limited = limitedKey;
    expect((await json()).ok).toBe(true);
    expect(keysUsed()).toEqual(["limited"]);
  });

  it("moves past a rate-limited key: limits are per key", async () => {
    mocks.getProviderConnections.mockResolvedValue(conns("busy", "good"));
    verdict.busy = rateLimit;
    verdict.good = works;
    expect((await json()).ok).toBe(true);
    expect(keysUsed()).toEqual(["busy", "good"]);
  });

  it("moves past a key rate-limited on the model probes, and says so if it was the only one", async () => {
    mocks.getProviderConnections.mockResolvedValue(conns("busy", "good"));
    verdict.busy = modelsRateLimited;
    verdict.good = works;
    expect((await json()).ok).toBe(true);
    expect(keysUsed()).toEqual(["busy", "good"]);
    vi.clearAllMocks();
    mocks.getProviderConnections.mockResolvedValue(conns("busy"));
    expect(await json()).toMatchObject({ ok: false, error: "The endpoint kept rate-limiting, so some models weren't checked" });
  });

  it("doesn't count a key whose model checks were cut short as working, and says why", async () => {
    mocks.getProviderConnections.mockResolvedValue(conns("slow", "spare"));
    verdict.slow = cutShort;
    expect(await json()).toMatchObject({ ok: false, error: "Detection ran out of time, so some models weren't checked" });
    expect(keysUsed()).toEqual(["slow"]);
  });

  it("says how many keys didn't get through before the one that did", async () => {
    mocks.getProviderConnections.mockResolvedValue(conns("dead", "busy", "good"));
    verdict.busy = rateLimit;
    verdict.good = works;
    expect(await json()).toMatchObject({ ok: true, keysFailedFirst: 2, baseKeysFailed: 2 });
    vi.clearAllMocks();
    mocks.getProviderConnections.mockResolvedValue(conns("good"));
    const body = await json();
    expect(body.keysFailedFirst).toBeUndefined();
    expect(body.baseKeysFailed).toBeUndefined();
  });

  it("doesn't spend an attempt on a key with no credential", async () => {
    mocks.getProviderConnections.mockResolvedValue([...conns("", "", "", "", ""), ...conns("good")]);
    verdict.good = works;
    expect((await json()).ok).toBe(true);
    expect(keysUsed()).toEqual(["good"]);
  });

  it("never blames a key when there is none to blame", async () => {
    mocks.getProviderConnections.mockResolvedValue([]);
    verdict[""] = refusedLater;
    expect(await json()).toMatchObject({ ok: true, usedKey: false });
  });

  it.each([
    ["has no keys", [], "It needs a key, and this endpoint has none"],
    ["has only switched-off keys", [{ id: "x", isActive: false, apiKey: "off" }], "It needs a key, and none of its keys is switched on"],
    ["has a switched-on key with no credential", [{ id: "x", isActive: true, apiKey: "" }], "It needs a key, and no switched-on key has one set"],
  ])("says the endpoint needs a key, not that a key was rejected, when it %s", async (_label, list, error) => {
    mocks.getProviderConnections.mockResolvedValue(list);
    expect(await json()).toMatchObject({ ok: false, error, usedKey: false });
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

  it("says when the keys on the endpoint's URL failed before a key's own URL got through", async () => {
    mocks.getProviderConnections.mockResolvedValue([...conns("dead"), ...ownConns("o1")]);
    verdict.o1 = works;
    expect(await json()).toMatchObject({ ok: true, viaKeyUrl: true, keysFailedFirst: 1, baseKeysFailed: 1 });
    vi.clearAllMocks();
    mocks.getProviderConnections.mockResolvedValue(ownConns("o0", "o1"));
    expect(await json()).toMatchObject({ ok: true, viaKeyUrl: true, keysFailedFirst: 1, baseKeysFailed: 0 });
  });

  it("reports the first key's verdict, and that more were tried, when none gets through", async () => {
    mocks.getProviderConnections.mockResolvedValue([...conns("shared"), ...ownConns("o1")]);
    verdict.o1 = down;
    const body = await json();
    expect(body).toMatchObject({ ok: false, error: "None of the 2 keys it tried worked. The first: Wrong key" });
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

  it("treats a key whose own URL is the endpoint's URL as on the endpoint's URL", async () => {
    mocks.getProviderConnections.mockResolvedValue([...ownConns("other"),
      { id: "same", isActive: true, apiKey: "same", providerSpecificData: { ownBaseUrl: true, baseUrl: "https://api.acme.dev/v1/" } }]);
    verdict.same = works;
    const body = await json();
    expect(keysUsed()).toEqual(["same"]);
    expect(body).toMatchObject({ ok: true, keyScoped: false });
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
    verdict.gated = { ok: false, failure: "gated", keyVerdict: null, clientGated: true, error: "Only works as a known client.", steps: [] };
    mocks.retryAsClient.mockImplementation(async (first, opts) => {
      expect(opts).toMatchObject({ url: "https://acct-gated.acme.dev/v1", apiKey: "gated" });
      expect(opts.fetchFn.forKey).toBe("gated");
      return opts.detect(() => {});
    });
    await json();
    expect(urlsUsed()).toEqual(["https://acct-gated.acme.dev/v1", "https://acct-gated.acme.dev/v1"]);
    expect(keysUsed()).toEqual(["gated", "gated"]);
    // Without the saved identity: the retry's headers replace it.
    expect(mocks.savedSettingsFetch.mock.calls.map((c) => c[3])).toEqual([undefined, { identity: false }]);
  });
});

describe("re-detect model check: one run across keys", () => {
  it("shares one time budget across keys, so the page's 60s wait isn't outrun", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      mocks.getProviderConnections.mockResolvedValue(conns("a", "b", "c", "d", "e"));
      // Every rejected key takes 15s to answer; the fourth starts with exactly the 5s minimum left.
      mocks.detectEndpoint.mockImplementation(() => { vi.setSystemTime(Date.now() + 15_000); return Promise.resolve(rejected); });
      await json();
      expect(mocks.detectEndpoint.mock.calls.map((c) => c[0].deadlineMs)).toEqual([50_000, 35_000, 20_000, 5_000]);
    } finally { vi.useRealTimers(); }
  });

  it("gives the client-identity retry what's left of the budget", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      mocks.getProviderConnections.mockResolvedValue(conns("gated"));
      const gated = { ok: false, failure: "gated", keyVerdict: null, clientGated: true, error: "Only works as a known client.", steps: [] };
      // The first run takes 30s of the 50s.
      mocks.detectEndpoint.mockImplementationOnce(() => { vi.setSystemTime(Date.now() + 30_000); return Promise.resolve(gated); });
      let retrySignal;
      mocks.retryAsClient.mockImplementation(async (first, opts) => { retrySignal = opts.signal; return opts.detect(() => {}); });
      await json();
      expect(mocks.detectEndpoint.mock.calls.map((c) => c[0].deadlineMs)).toEqual([50_000, 20_000]);
      // The identity search's signal isn't the bare request signal: it also times out.
      expect(retrySignal).toBeInstanceOf(AbortSignal);
      expect(retrySignal).not.toBe(mocks.detectEndpoint.mock.calls[0][0].signal);
      expect(retrySignal.aborted).toBe(false);
      mocks.signal.abort();
      expect(retrySignal.aborted).toBe(true);
    } finally { vi.useRealTimers(); }
  });

  it("ends the client-identity search when the budget runs out", async () => {
    mocks.getProviderConnections.mockResolvedValue(conns("gated"));
    mocks.detectEndpoint.mockImplementationOnce(() => Promise.resolve({ ok: false, failure: "gated", keyVerdict: null, clientGated: true, error: "Only works as a known client.", steps: [] }));
    let aborted;
    mocks.retryAsClient.mockImplementation(async (first, opts) => {
      // Real timers: the route's budget is 50s here, so shrink it by waiting on a short one.
      aborted = await new Promise((resolve) => {
        if (opts.signal.aborted) return resolve(true);
        opts.signal.addEventListener("abort", () => resolve(true));
        setTimeout(() => resolve(false), 200);
      });
      return first;
    });
    vi.spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValue(49_950);
    try { await json(); } finally { vi.restoreAllMocks(); }
    expect(aborted).toBe(true);
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

  it("numbers the client-identity retry's requests on from the first run", async () => {
    mocks.getProviderConnections.mockResolvedValue(conns("gated"));
    let call = 0;
    mocks.detectEndpoint.mockImplementation(({ onProgress }) => {
      onProgress({ type: "request", n: 1, sent: 1 });
      onProgress({ type: "request", n: 2, sent: 2 });
      return Promise.resolve(call++ ? works : { ok: false, failure: "gated", keyVerdict: null, clientGated: true, error: "Only works as a known client.", steps: [] });
    });
    mocks.retryAsClient.mockImplementation((first, opts) => opts.detect(() => {}));
    await json();
    expect(mocks.sent.map((e) => [e.n, e.sent])).toEqual([[1, 1], [2, 2], [3, 3], [4, 4]]);
  });
});

describe("re-detect apply (PUT)", () => {
  it("keeps models added while switching API on the API they were found on", async () => {
    const { PUT } = await import("@/app/api/providers/[id]/redetect/route.ts");
    const db = await import("@/lib/localDb");
    mocks.getProviderNodeById.mockResolvedValue({ id: "ep1", type: "openai-compatible", apiType: "chat", baseUrl: "https://api.acme.dev/v1" });
    mocks.getCustomModels.mockResolvedValue([{ id: "old", providerAlias: "ep1", type: "llm" }]);
    mocks.getProviderConnections.mockResolvedValue([]);
    db.updateProviderNode.mockImplementation(async (_id, updates) => ({ id: "ep1", type: "openai-compatible", baseUrl: "https://api.acme.dev/v1", ...updates }));
    const res = await PUT(new Request("https://dash.local/api/providers/ep1/redetect", { method: "PUT", body: JSON.stringify({ apiType: "responses", addModels: ["new"] }) }), { params: Promise.resolve({ id: "ep1" }) });
    expect(res.status).toBe(200);
    expect(db.updateProviderNode.mock.calls[0][1]).toMatchObject({ apiType: "responses", modelRoutes: { old: "openai-chat", new: "openai-chat" } });
  });
});
