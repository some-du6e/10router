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
const refusedLater = { ...unlisted, authRejected: true, stopReason: "auth", keyVerdict: "refused", partialReason: "The key was rejected part-way through, so some models weren't checked." };
// A key the bad-key check proved, whose model probes were then refused: limited, not dead.
const provedThenRefused = { ...unlisted, stopReason: "auth", keyVerdict: null, partialReason: refusedLater.partialReason };
// A key limited to models outside the ones asked about: not dead, but another key may see more.
const limitedKey = { ...unlisted, authRejected: true, stopReason: "denied", keyVerdict: null, partialReason: "The key isn't allowed to use any of the models checked." };
// Only GET /models refused the key, and no API path answered.
const listOnlyFail = { ok: false, failure: "key", keyVerdict: null, error: "The key was rejected.", steps: [] };
const rateLimit = { ok: false, failure: "rate", keyVerdict: "rate-limited", error: "The endpoint is rate-limiting requests.", steps: [] };
// The free probes passed, then the model probes kept getting 429s and found nothing.
const modelsRateLimited = { ...unlisted, stopReason: "rate", keyVerdict: "rate-limited", partialReason: "The endpoint kept rate-limiting, so some models weren't checked." };
// Only GET /models refused the key (an admin-only list); nothing says whether the key is bad.
const listOnlyRefused = { ...unlisted, authRejected: true, stopReason: null, keyVerdict: null };
// The model probes were cut short (time, 5xx) before they told anything.
// (A deadline cut uses up the shared budget, so only failures lead to another key.)
const cutShort = { ...unlisted, stopReason: "failing", keyVerdict: null, partialReason: "The endpoint kept failing (network errors, timeouts or 5xx), so some models weren't checked." };

const req = (part = "models") => new Request(`https://dash.local/api/providers/ep1/redetect?part=${part}`, { method: "POST" });
const call = (part) => POST(req(part), { params: Promise.resolve({ id: "ep1" }) });
const json = (part) => call(part).then((r) => r.json());
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
  // Tagged with the fetch it wraps, so tests can see the SSRF-checked one is used.
  mocks.savedSettingsFetch.mockImplementation((f) => Object.assign(() => {}, { wraps: f }));
  mocks.redetectDiff.mockImplementation((_node, _current, r, _outdated, _part, opts = {}) => r.ok
    ? { ok: true, protocol: null, baseUrl: null, addModels: r.models, removeModels: [], outdatedModels: [], quirks: {}, modelsNote: null, changes: r.models.length, keyScoped: !!opts.keyScoped }
    : { ok: false, error: r.error, protocol: null, baseUrl: null, addModels: [], removeModels: [], outdatedModels: [], quirks: {}, modelsNote: null, changes: 0 });
  verdict = {};
  mocks.detectEndpoint.mockImplementation(({ apiKey }) => Promise.resolve(verdict[apiKey] ?? rejected));
});

describe("re-detect model check: keys on the endpoint's URL", () => {
  it("falls through a rejected key to the next one", async () => {
    mocks.getProviderConnections.mockResolvedValue(conns("dead", "good"));
    verdict.good = works;
    expect(await json()).toMatchObject({ ok: true, usedKey: true });
    expect(keysUsed()).toEqual(["dead", "good"]);
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
    expect(body.otherKeysFailed).toBeUndefined();
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

  it("doesn't blame a key that only GET /models refused, but tries another", async () => {
    mocks.getProviderConnections.mockResolvedValue(conns("fine", "spare"));
    verdict.fine = listOnlyRefused;
    const body = await json();
    expect(body.ok).toBe(true);
    expect(body.error).toBeUndefined();
    expect(keysUsed()).toEqual(["fine", "spare"]);
  });

  it("never passes on a refusal of the key as the reason the checks stopped", async () => {
    mocks.getProviderConnections.mockResolvedValue(conns("proved"));
    verdict.proved = provedThenRefused;
    expect(await json()).toMatchObject({ ok: true, partialReason: "The endpoint refused the models it was asked about, so some weren't checked." });
  });

  it("probes every key, at its own URL too, through the SSRF-checked fetch for remote callers", async () => {
    mocks.guardTarget.mockResolvedValue({ remote: true });
    const guarded = () => {}, open = () => {};
    mocks.makeProbeFetch.mockImplementation((remote) => (remote ? guarded : open));
    mocks.getProviderConnections.mockResolvedValue([...conns("k1"), ...ownConns("o1")]);
    verdict.o1 = works;
    await json();
    expect(keysUsed()).toEqual(["k1", "o1"]);
    expect(mocks.makeProbeFetch.mock.calls.every(([remote]) => remote === true)).toBe(true);
    for (const c of mocks.detectEndpoint.mock.calls) expect(c[0].fetchFn.wraps).toBe(guarded);
  });

  it("asks only keys on the endpoint's URL in the endpoint half, when it has any", async () => {
    mocks.getProviderConnections.mockResolvedValue([...conns("base"), ...ownConns("o1")]);
    verdict.base = listOnlyRefused;
    verdict.o1 = works;
    const body = await json("endpoint");
    expect(keysUsed()).toEqual(["base"]);
    expect(body).toMatchObject({ ok: true });
    expect(body.viaKeyUrl).toBeUndefined();
    // Every key on the endpoint's URL refused: a failure, not "nothing changed" from another account.
    vi.clearAllMocks();
    mocks.getProviderConnections.mockResolvedValue([...conns("dead"), ...ownConns("o1")]);
    expect(await json("endpoint")).toMatchObject({ ok: false, error: rejected.error });
    expect(keysUsed()).toEqual(["dead"]);
    // The endpoint half asks about no models, so it holds back no removals.
    vi.clearAllMocks();
    mocks.getProviderConnections.mockResolvedValue(conns("dead", "good"));
    verdict.good = works;
    expect((await json("endpoint")).removalsHeld).toBeUndefined();
    // The models half goes on to the account that works.
    vi.clearAllMocks();
    mocks.getProviderConnections.mockResolvedValue([...conns("base"), ...ownConns("o1")]);
    expect(await json("models")).toMatchObject({ viaKeyUrl: true });
    // With no key on the endpoint's URL, the endpoint half asks the own-URL keys.
    vi.clearAllMocks();
    mocks.getProviderConnections.mockResolvedValue(ownConns("o0", "o1"));
    expect(await json("endpoint")).toMatchObject({ ok: true, viaKeyUrl: true });
    expect(keysUsed()).toEqual(["o0", "o1"]);
  });

  it("sends the client-identity search through the SSRF-checked fetch too", async () => {
    mocks.guardTarget.mockResolvedValue({ remote: true });
    const guarded = () => {}, open = () => {};
    mocks.makeProbeFetch.mockImplementation((remote) => (remote ? guarded : open));
    mocks.getProviderConnections.mockResolvedValue(ownConns("gated"));
    verdict.gated = { ok: false, failure: "gated", keyVerdict: null, clientGated: true, error: "Only works as a known client.", steps: [] };
    let retryFetch;
    mocks.retryAsClient.mockImplementation(async (first, opts) => { retryFetch = opts.fetchFn; return first; });
    await json();
    expect(retryFetch.wraps).toBe(guarded);
  });

  it("says how many keys it tried when some were refused late and the rest outright", async () => {
    mocks.getProviderConnections.mockResolvedValue(conns("late", "bad"));
    verdict.late = refusedLater;
    expect(await json()).toMatchObject({ ok: false, error: "None of the 2 keys it tried was accepted" });
  });

  it("tries another key after one limited to other models, and shows it, not a rejection, if none does better", async () => {
    mocks.getProviderConnections.mockResolvedValue(conns("limited", "spare"));
    verdict.limited = limitedKey;
    expect(await json()).toMatchObject({ ok: true, partialReason: limitedKey.partialReason });
    expect(keysUsed()).toEqual(["limited", "spare"]);
  });

  it("tries another key when only GET /models refused one, and doesn't call it rejected", async () => {
    mocks.getProviderConnections.mockResolvedValue(conns("admin-only", "good"));
    verdict["admin-only"] = listOnlyFail;
    verdict.good = works;
    expect((await json()).ok).toBe(true);
    expect(keysUsed()).toEqual(["admin-only", "good"]);
    vi.clearAllMocks();
    mocks.getProviderConnections.mockResolvedValue(conns("admin-only"));
    expect(await json()).toMatchObject({ ok: false, error: "The model list refused the key, and no API answered" });
  });

  it("names a later key that met a failing server, as well as the first key's refusal", async () => {
    mocks.getProviderConnections.mockResolvedValue(conns("dead", "good"));
    verdict.good = down;
    expect(await json()).toMatchObject({ ok: false, error: "None of the 2 keys it tried worked. The first: Wrong key. A later one: The endpoint didn't answer" });
  });

  it("doesn't name a later key that was only rate-limited or lost the model list", async () => {
    mocks.getProviderConnections.mockResolvedValue(conns("dead", "busy", "admin-only"));
    verdict.busy = rateLimit;
    verdict["admin-only"] = listOnlyFail;
    expect(await json()).toMatchObject({ ok: false, error: "None of the 3 keys it tried worked. The first: Wrong key" });
  });

  it("doesn't count a later key that only ran out of the shared time as tried", async () => {
    const late = { ok: false, failure: "timeout", keyVerdict: null, error: "Detection ran out of time before an API answered. Try again.", steps: [] };
    mocks.getProviderConnections.mockResolvedValue(conns("dead", "late"));
    verdict.late = late;
    expect(await json()).toMatchObject({ ok: false, error: "Wrong key. Another key ran out of time before it was checked" });
    // Nor as a key that didn't get through, next to one that answered.
    vi.clearAllMocks();
    mocks.getProviderConnections.mockResolvedValue(conns("slow", "late"));
    verdict.slow = cutShort;
    verdict.late = late;
    const body = await json();
    expect(body.ok).toBe(true);
    expect(body.otherKeysFailed).toBeUndefined();
  });

  it("tries the next key after a web server's own 401 page", async () => {
    // nginx in front of the API refusing the token with its HTML page.
    const nginx401 = { ok: false, failure: "html", keyVerdict: null, error: 'This isn\'t an API response (got "401 Authorization Required").', steps: [{ label: "POST /chat/completions (empty)", url: "https://api.acme.dev/v1/chat/completions", status: 401, preview: "", html: true }] };
    mocks.getProviderConnections.mockResolvedValue(conns("dead", "good"));
    verdict.dead = nginx401;
    verdict.good = works;
    expect((await json()).ok).toBe(true);
    expect(keysUsed()).toEqual(["dead", "good"]);
    // A 403 page (a WAF or bot block, the same for every key), or one with no 401: no other key.
    vi.clearAllMocks();
    mocks.getProviderConnections.mockResolvedValue(conns("dead", "good"));
    verdict.dead = { ...nginx401, steps: [{ ...nginx401.steps[0], status: 403 }] };
    await json();
    expect(keysUsed()).toEqual(["dead"]);
    vi.clearAllMocks();
    mocks.getProviderConnections.mockResolvedValue(conns("dead", "good"));
    verdict.dead = { ...nginx401, steps: [{ ...nginx401.steps[0], status: 200 }] };
    await json();
    expect(keysUsed()).toEqual(["dead"]);
  });

  it("lets a key's own URL speak for the API and fixes only when no key uses the endpoint's URL", async () => {
    mocks.getProviderConnections.mockResolvedValue(ownConns("o0", "o1"));
    verdict.o1 = works;
    expect(await json("endpoint")).toMatchObject({ ok: true, viaKeyUrl: true });
    expect(mocks.redetectDiff.mock.calls[0][5]).toMatchObject({ keyScoped: false, ownUrl: true });
    vi.clearAllMocks();
    mocks.getProviderConnections.mockResolvedValue([...conns("dead"), ...ownConns("o1")]);
    verdict.o1 = works;
    expect(await json("models")).toMatchObject({ ok: true, viaKeyUrl: true, keyScoped: true });
    expect(mocks.redetectDiff.mock.calls[0][5]).toMatchObject({ keyScoped: true, ownUrl: true });
  });

  it("says a lone failure at a key's own URL happened there", async () => {
    mocks.getProviderConnections.mockResolvedValue(ownConns("o0"));
    verdict.o0 = down;
    expect(await json()).toMatchObject({ ok: false, error: "The endpoint didn't answer (at the key's own URL)" });
  });

  it("says when another key ran out of time before it was checked", async () => {
    mocks.getProviderConnections.mockResolvedValue(conns("first", "late"));
    verdict.first = { ...rejected, keyVerdict: "refused" };
    verdict.late = { ok: false, failure: "timeout", keyVerdict: null, error: "Detection ran out of time before an API answered. Try again.", steps: [] };
    expect(await json()).toMatchObject({ ok: false, error: "Wrong key. Another key ran out of time before it was checked" });
    // A lone key cut off still counts as tried.
    vi.clearAllMocks();
    mocks.getProviderConnections.mockResolvedValue(conns("late"));
    expect(await json()).toMatchObject({ ok: false, error: verdict.late.error });
  });

  it("names neither a later key cut off by time nor one refused by a web page", async () => {
    const nginx401 = { ok: false, failure: "html", keyVerdict: null, error: "This isn't an API response.", steps: [{ status: 401 }] };
    mocks.getProviderConnections.mockResolvedValue(conns("dead", "busy", "page", "late"));
    verdict.busy = rateLimit;
    verdict.page = nginx401;
    verdict.late = { ok: false, failure: "timeout", keyVerdict: null, error: "Detection ran out of time before an API answered. Try again.", steps: [] };
    expect((await json()).error).toBe("None of the 3 keys it tried worked. The first: Wrong key. Another key ran out of time before it was checked");
  });

  it("hands the half that asked, the request's signal and skipModels to every call", async () => {
    mocks.getProviderConnections.mockResolvedValue(conns("gated"));
    mocks.detectEndpoint.mockImplementationOnce(() => Promise.resolve({ ok: false, failure: "gated", keyVerdict: null, clientGated: true, error: "Only works as a known client.", steps: [] }));
    mocks.retryAsClient.mockImplementation((first, opts) => opts.detect(() => {}));
    await json("endpoint");
    for (const [o] of mocks.detectEndpoint.mock.calls) {
      expect(o.skipModels).toBe(true);
      expect(o.signal).toBe(mocks.signal.signal);
    }
    expect(mocks.detectEndpoint).toHaveBeenCalledTimes(2);
    expect(mocks.redetectDiff.mock.calls[0][4]).toBe("endpoint");
    vi.clearAllMocks();
    mocks.getProviderConnections.mockResolvedValue(conns("good"));
    verdict.good = works;
    await json("models");
    expect(mocks.detectEndpoint.mock.calls[0][0].skipModels).toBe(false);
    expect(mocks.redetectDiff.mock.calls[0][4]).toBe("models");
  });

  it("tries the endpoint's URL first even past five keys with their own", async () => {
    mocks.getProviderConnections.mockResolvedValue([...ownConns("o1", "o2", "o3", "o4", "o5"), ...conns("base")]);
    verdict.base = works;
    await json();
    expect(keysUsed()).toEqual(["base"]);
  });

  it("says a key that can list models but every API refused was rejected, and tries the next", async () => {
    const listOnlyKey = { ok: false, failure: "no-api", keyVerdict: "refused", error: "No OpenAI or Anthropic API found at this URL.", steps: [] };
    mocks.getProviderConnections.mockResolvedValue(conns("lister", "good"));
    verdict.lister = listOnlyKey;
    verdict.good = works;
    expect((await json()).ok).toBe(true);
    expect(keysUsed()).toEqual(["lister", "good"]);
    vi.clearAllMocks();
    mocks.getProviderConnections.mockResolvedValue(conns("lister"));
    expect(await json()).toMatchObject({ ok: false, error: "The key can list models, but every API refused it" });
  });

  it("lets only the first key's model list remove models, and says when it held them back", async () => {
    mocks.getProviderConnections.mockResolvedValue(conns("good"));
    verdict.good = works;
    expect((await json()).removalsHeld).toBeUndefined();
    expect(mocks.redetectDiff.mock.calls[0][5]).toMatchObject({ removals: true });
    vi.clearAllMocks();
    mocks.getProviderConnections.mockResolvedValue(conns("busy", "good"));
    verdict.busy = rateLimit;
    expect(await json()).toMatchObject({ removalsHeld: true });
    expect(mocks.redetectDiff.mock.calls[0][5]).toMatchObject({ removals: false });
    // A guessed list never removes anything, so nothing was held back.
    vi.clearAllMocks();
    mocks.getProviderConnections.mockResolvedValue(conns("busy", "good"));
    verdict.good = { ...works, modelsSource: "guessed" };
    expect((await json()).removalsHeld).toBeUndefined();
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
    expect(await json()).toMatchObject({ ok: false, error: "The endpoint kept rate-limiting the model checks. Try again in a minute" });
  });

  it("tries the next key after a check cut short, and takes one that works", async () => {
    mocks.getProviderConnections.mockResolvedValue(conns("slow", "good"));
    verdict.slow = cutShort;
    verdict.good = works;
    const body = await json();
    expect(body).toMatchObject({ ok: true, addModels: ["m1"] });
    expect(body.partialReason).toBeUndefined();
    expect(body.otherKeysFailed).toBeUndefined(); // it got through, only cut short
    expect(keysUsed()).toEqual(["slow", "good"]);
  });

  it("shows a check cut short, and why, when no other key does better", async () => {
    mocks.getProviderConnections.mockResolvedValue(conns("dead", "slow", "spare"));
    verdict.slow = cutShort;
    expect(await json()).toMatchObject({ ok: true, otherKeysFailed: 2, baseKeysTried: 2, partialReason: cutShort.partialReason });
    expect(keysUsed()).toEqual(["dead", "slow", "spare"]);
  });

  it("doesn't count a check that was only cut short as a key that didn't get through", async () => {
    mocks.getProviderConnections.mockResolvedValue([...conns("slow"), ...ownConns("o1")]);
    verdict.slow = cutShort;
    verdict.o1 = works;
    const body = await json();
    // Tried on the endpoint's URL, but not a key that didn't get through.
    expect(body).toMatchObject({ ok: true, viaKeyUrl: true, baseKeysTried: 1 });
    expect(body.otherKeysFailed).toBeUndefined();
  });

  it("shows a lone check whose model probes told nothing as it is, not as a failure", async () => {
    // The made-up-model check got a 5xx: no verdict, and the run says why.
    mocks.getProviderConnections.mockResolvedValue(conns("only"));
    verdict.only = { ...unlisted, keyVerdict: null, partialReason: cutShort.partialReason };
    const body = await json();
    expect(body).toMatchObject({ ok: true, partialReason: cutShort.partialReason });
    expect(body.error).toBeUndefined();
  });

  it("says how many keys didn't get through before the one that did", async () => {
    mocks.getProviderConnections.mockResolvedValue(conns("dead", "busy", "good"));
    verdict.busy = rateLimit;
    verdict.good = works;
    expect(await json()).toMatchObject({ ok: true, otherKeysFailed: 2, baseKeysTried: 2 });
    vi.clearAllMocks();
    mocks.getProviderConnections.mockResolvedValue(conns("good"));
    const body = await json();
    expect(body.otherKeysFailed).toBeUndefined();
    expect(body.baseKeysTried).toBeUndefined();
    expect(body.partialReason).toBeUndefined();
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
    const body = await json();
    expect(body).toMatchObject({ ok: true, usedKey: false });
    expect(body.partialReason).toBeUndefined();
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
    // Every active key has its own URL, so the result isn't scoped to one account.
    expect(await json()).toMatchObject({ ok: true, usedKey: true, viaKeyUrl: true, keyScoped: false });
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
    const viaOwn = await json();
    expect(viaOwn).toMatchObject({ ok: true, viaKeyUrl: true, otherKeysFailed: 1, baseKeysTried: 1 });
    // Its list never removes anything anyway, so nothing is "held back".
    expect(viaOwn.removalsHeld).toBeUndefined();
    vi.clearAllMocks();
    mocks.getProviderConnections.mockResolvedValue(ownConns("o0", "o1"));
    const body = await json();
    expect(body).toMatchObject({ ok: true, viaKeyUrl: true, otherKeysFailed: 1 });
    expect(body.baseKeysTried).toBeUndefined();
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
      return opts.detect(() => {});
    });
    await json();
    expect(urlsUsed()).toEqual(["https://acct-gated.acme.dev/v1", "https://acct-gated.acme.dev/v1"]);
    expect(keysUsed()).toEqual(["gated", "gated"]);
    // Without the saved identity: the retry's headers replace it.
    expect(mocks.savedSettingsFetch.mock.calls.map((c) => c[2])).toEqual([undefined, { identity: false }]);
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

