// Re-detect on the endpoint page: what changed since the endpoint was added.
import { describe, expect, it } from "vitest";
import { redetectDiff, modelsNoteFor, savedSettingsFetch } from "../../src/app/api/providers/[id]/redetect/diff.ts";

const node = { type: "openai-compatible", apiType: "chat", baseUrl: "https://api.acme.dev/v1" };
const found = (over = {}) => ({ ok: true, steps: [], protocol: "openai-chat", baseUrl: "https://api.acme.dev/v1", models: ["a", "b"], modelsSource: "models", quirks: {}, ...over });

describe("redetectDiff", () => {
  it("reports nothing when nothing changed", () => {
    const d = redetectDiff(node, ["a", "b"], found());
    expect(d).toMatchObject({ ok: true, changes: 0, protocol: null, baseUrl: null, addModels: [], removeModels: [] });
  });
  it("finds new and gone models; only removes when /models listed them", () => {
    expect(redetectDiff(node, ["a", "old"], found())).toMatchObject({ addModels: ["b"], removeModels: ["old"], changes: 2 });
    expect(redetectDiff(node, ["a", "old"], found({ modelsSource: "guessed" })).removeModels).toEqual([]);
  });
  it("offers outdated models separately, never ones the endpoint just listed", () => {
    const d = redetectDiff(node, ["a", "b", "old-4"], found({ models: ["a", "b", "new-5"], modelsSource: "guessed" }), ["a", "old-4", "new-5"]);
    expect(d).toMatchObject({ removeModels: [], outdatedModels: ["old-4"], changes: 2 });
    expect(d.addModels).toEqual(["new-5"]);
    // Gone from /models and outdated: listed once, under the ticked row.
    expect(redetectDiff(node, ["a", "old-4"], found({ models: ["a"] }), ["old-4"])).toMatchObject({ removeModels: ["old-4"], outdatedModels: [] });
  });
  it("never removes models a cut-short /models list missed, and matches ids ignoring case", () => {
    expect(redetectDiff(node, ["a", "b"], found({ models: ["a"], listComplete: false })).removeModels).toEqual([]);
    expect(redetectDiff(node, ["a", "B"], found({ models: ["a", "b"] })).removeModels).toEqual([]);
  });
  it("splits into an endpoint check and a models check", () => {
    const r = found({ protocol: "openai-responses", baseUrl: "https://api.acme.dev/v2", models: ["a", "new"], quirks: { maxCompletionTokens: true },
      byProtocol: { "openai-responses": ["a"], anthropic: ["new"] } });
    const ep = redetectDiff(node, ["a", "gone"], r, ["a"], "endpoint");
    expect(ep).toMatchObject({ addModels: [], removeModels: [], outdatedModels: [], modelsNote: null, quirks: { maxCompletionTokens: true }, changes: 3 });
    expect(ep.protocol.to).toBe("openai-responses");
    const ms = redetectDiff(node, ["a", "gone"], r, [], "models");
    expect(ms).toMatchObject({ protocol: null, baseUrl: null, addModels: ["new"], removeModels: ["gone"] });
    // Endpoint half alone never moves off a saved API that still answers.
    expect(redetectDiff(node, ["a"], found({ protocol: "anthropic", protocols: ["anthropic", "openai-chat"] }), [], "endpoint").protocol).toBeNull();
    // Routes stay relative to the saved API: switching it is the endpoint check's call.
    expect(ms.quirks).toEqual({ modelRoutes: { a: "openai-responses", new: "anthropic" } });
  });
  it("offers Chat <-> Responses in place, not OpenAI <-> Anthropic", () => {
    expect(redetectDiff(node, ["a", "b"], found({ protocol: "openai-responses" })).protocol).toEqual({ from: "openai-chat", to: "openai-responses", applicable: true });
    expect(redetectDiff(node, ["a", "b"], found({ protocol: "anthropic" })).protocol.applicable).toBe(false);
  });
  it("notices a moved URL and new fixes", () => {
    const d = redetectDiff(node, ["a", "b"], found({ baseUrl: "https://api.acme.dev/v2/", quirks: { maxCompletionTokens: true, apiKeyHeader: true } }));
    expect(d.baseUrl).toEqual({ from: "https://api.acme.dev/v1", to: "https://api.acme.dev/v2" });
    expect(d.quirks).toEqual({ maxCompletionTokens: true, apiKeyHeader: "api-key" });
    expect(redetectDiff({ ...node, maxCompletionTokens: true, apiKeyHeader: "api-key" }, ["a", "b"], found({ quirks: { maxCompletionTokens: true, apiKeyHeader: true } })).quirks).toEqual({});
  });
  it("builds routes around the saved API, not the API with the most models", () => {
    const anth = { type: "anthropic-compatible", baseUrl: "https://api.acme.dev/v1" };
    // More Claude models than GPT: detection's own routes would be relative to anthropic.
    const r = found({ protocol: "anthropic", modelsSource: "guessed", models: ["claude-a", "claude-b", "gpt-x"],
      byProtocol: { anthropic: ["claude-a", "claude-b"], "openai-chat": ["gpt-x"] }, routes: { "gpt-x": "openai-chat" } });
    expect(redetectDiff(anth, ["claude-a", "claude-b", "gpt-x"], r).quirks.modelRoutes).toEqual({ "claude-a": "anthropic", "claude-b": "anthropic", "gpt-x": "openai-chat" });
    // OpenAI node, same probes: wrong-relative routes { gpt-x: openai-chat } would leave Claude on chat.
    const d = redetectDiff(node, ["claude-a", "claude-b", "gpt-x"], { ...r, protocol: "anthropic" });
    expect(d.quirks.modelRoutes).toEqual({ "claude-a": "anthropic", "claude-b": "anthropic", "gpt-x": "openai-chat" });
    // Already saved: no change.
    expect(redetectDiff({ ...node, modelRoutes: { "claude-a": "anthropic", "claude-b": "anthropic" } }, ["claude-a", "claude-b", "gpt-x"], r).quirks.modelRoutes).toBeUndefined();
  });
  it("routes against the new API when Chat -> Responses is offered", () => {
    const r = found({ protocol: "openai-responses", modelsSource: "guessed", models: ["gpt-x", "claude-a"],
      byProtocol: { "openai-responses": ["gpt-x"], anthropic: ["claude-a"] } });
    const d = redetectDiff(node, ["gpt-x", "claude-a"], r);
    expect(d.protocol.to).toBe("openai-responses");
    expect(d.quirks.modelRoutes).toEqual({ "gpt-x": "openai-responses", "claude-a": "anthropic" });
  });
  it("moves a saved route once its API was checked in full without the model", () => {
    const saved = { ...node, modelRoutes: { "claude-a": "anthropic" } };
    const done = { total: 2, checked: 2, found: 0, unchecked: [], stopped: null };
    const r = found({ modelsSource: "guessed", models: ["claude-a", "gpt-x"], byProtocol: { "openai-chat": ["claude-a", "gpt-x"], anthropic: [] },
      checks: { "openai-chat": { ...done, found: 2 }, anthropic: done } });
    // Every model now on the saved API: the PUT drops those, clearing the route.
    expect(redetectDiff(saved, ["claude-a", "gpt-x"], r, [], "models").quirks.modelRoutes).toEqual({ "claude-a": "openai-chat", "gpt-x": "openai-chat" });
  });
  it("never offers clearing saved routes: an API that failed its probe looks the same", () => {
    // Anthropic answered 503 on its free probe, so only Chat was asked.
    const saved = { ...node, modelRoutes: { "claude-a": "anthropic" } };
    const r = found({ modelsSource: "guessed", models: ["claude-a", "gpt-x"], byProtocol: { "openai-chat": ["claude-a", "gpt-x"] } });
    expect(redetectDiff(saved, ["claude-a", "gpt-x"], r).quirks.modelRoutes).toBeUndefined();
    expect(redetectDiff(saved, ["claude-a", "gpt-x"], r).changes).toBe(0);
    expect(redetectDiff(saved, ["claude-a", "gpt-x"], { ...r, partial: true }).quirks.modelRoutes).toBeUndefined();
    expect(redetectDiff(node, ["claude-a", "gpt-x"], r).quirks.modelRoutes).toBeUndefined();
    // Listed via /models (no per-API probing): routes left alone.
    expect(redetectDiff(saved, ["a", "b"], found()).quirks.modelRoutes).toBeUndefined();
  });
  it("moves no saved route a cut-short run didn't finish checking", () => {
    const saved = { ...node, modelRoutes: { "claude-a": "anthropic", "claude-b": "anthropic" } };
    const ids = ["claude-a", "claude-b", "gpt-x"];
    const anth = (over) => ({ total: 3, checked: 3, found: 1, unchecked: [], stopped: null, ...over });
    const chat = anth({ found: 2 });
    // Anthropic stopped (5xx) before claude-b; claude-b answered on Chat.
    const cut = found({ modelsSource: "guessed", partial: true, models: ids,
      byProtocol: { "openai-chat": ["gpt-x", "claude-b"], anthropic: ["claude-a"] },
      checks: { anthropic: anth({ checked: 1, unchecked: ["claude-b"], stopped: "failing" }), "openai-chat": chat } });
    expect(redetectDiff(saved, ids, cut, [], "models").quirks.modelRoutes).toBeUndefined();
    // Still kept when another change is offered alongside.
    const more = { ...cut, models: [...ids, "gpt-y"], byProtocol: { ...cut.byProtocol, "openai-responses": ["gpt-y"] } };
    expect(redetectDiff(saved, ids, more, [], "models").quirks.modelRoutes)
      .toMatchObject({ "claude-a": "anthropic", "claude-b": "anthropic", "gpt-y": "openai-responses" });
    // Never reached at all: kept.
    const unreached = found({ modelsSource: "guessed", partial: true, models: ["claude-a", "gpt-x", "gpt-y"],
      byProtocol: { "openai-chat": ["gpt-x"], anthropic: ["claude-a"], "openai-responses": ["gpt-y"] }, checks: { anthropic: anth(), "openai-chat": chat } });
    expect(redetectDiff(saved, ids, unreached, [], "models").quirks.modelRoutes).toMatchObject({ "claude-b": "anthropic" });
    // Anthropic never stopped but left claude-b unasked (network errors): unfinished too.
    const unasked = { ...cut, checks: { ...cut.checks, anthropic: anth({ checked: 1, unchecked: ["claude-b"] }) } };
    expect(redetectDiff(saved, ids, unasked, [], "models").quirks.modelRoutes).toBeUndefined();
    // Anthropic finished without claude-b: it moved.
    const done = { ...cut, checks: { ...cut.checks, anthropic: anth() } };
    expect(redetectDiff(saved, ids, done, [], "models").quirks.modelRoutes)
      .toEqual({ "claude-a": "anthropic", "claude-b": "openai-chat", "gpt-x": "openai-chat" });
    // A full run: claude-a moved (Anthropic finished without it); claude-b was
    // never reached (outdated, so not asked) and keeps its route.
    const full = found({ modelsSource: "guessed", models: ["claude-a", "gpt-x"], byProtocol: { "openai-chat": ["gpt-x"], "openai-responses": ["claude-a"], anthropic: [] },
      checks: { anthropic: anth({ found: 0 }), "openai-chat": chat, "openai-responses": chat } });
    expect(redetectDiff(saved, ids, full, [], "models").quirks.modelRoutes)
      .toEqual({ "claude-a": "openai-responses", "claude-b": "anthropic", "gpt-x": "openai-chat" });
    // A full run where Anthropic failed its free probe (never asked): its routes stay.
    const noAnth = found({ modelsSource: "guessed", models: ["claude-a", "gpt-x", "gpt-y"], byProtocol: { "openai-chat": ["gpt-x", "claude-a"], "openai-responses": ["gpt-y"] },
      checks: { "openai-chat": chat, "openai-responses": chat } });
    expect(redetectDiff(saved, [...ids, "gpt-y"], noAnth, [], "models").quirks.modelRoutes)
      .toMatchObject({ "claude-a": "anthropic", "claude-b": "anthropic", "gpt-y": "openai-responses" });
  });
  it("offers no removals from a fallback key's list", () => {
    expect(redetectDiff(node, ["a", "gone"], found(), [], "models").removeModels).toEqual(["gone"]);
    expect(redetectDiff(node, ["a", "gone"], found(), [], "models", { removals: false }).removeModels).toEqual([]);
  });
  it("passes a failure through", () => {
    expect(redetectDiff(node, [], { ok: false, error: "401", steps: [] })).toMatchObject({ ok: false, error: "401", changes: 0 });
  });
  it("writes the models source note", () => {
    expect(modelsNoteFor({ modelsSource: "models", models: ["a"] })).toBe("imported from /models (1 model)");
    expect(modelsNoteFor({ modelsSource: "catalog", models: [] })).toMatch(/models\.dev/);
    expect(modelsNoteFor({ modelsSource: "none", models: [] })).toBeNull();
  });
});

describe("redetectDiff for one key at its own URL (keyScoped)", () => {
  // What a single own-URL account answered: another URL, fewer models, an
  // Azure-style key header, and a model split across APIs.
  const r = found({ baseUrl: "https://acct-1.acme.dev/v1", models: ["a", "new"], quirks: { apiKeyHeader: true, maxCompletionTokens: true },
    protocol: "openai-responses", byProtocol: { "openai-responses": ["a"], anthropic: ["new"] } });

  it("keeps that account's API, URL, fixes, routes and missing models out of the endpoint's changes", () => {
    const d = redetectDiff(node, ["a", "gone"], r, [], "all", { keyScoped: true });
    // "new" is served only on Anthropic, which this Chat endpoint has no route for.
    expect(d).toMatchObject({ ok: true, protocol: null, baseUrl: null, removeModels: [], addModels: [], quirks: {}, changes: 0 });
    expect(Object.keys(d.quirks)).toEqual([]);
  });

  it("adds only the models that account serves on the saved API", () => {
    const d = redetectDiff(node, ["a"], r, [], "models", { keyScoped: true });
    // "new" answered only on Anthropic; the endpoint is saved as Chat and gets no route for it.
    expect(d.addModels).toEqual([]);
    expect(redetectDiff(node, ["a"], found({ byProtocol: { "openai-chat": ["a", "b"] }, models: ["a", "b"] }), [], "models", { keyScoped: true }).addModels).toEqual(["b"]);
  });

  it("adds the models served on the saved API, not the ones on the API it would switch to", () => {
    const split = found({ protocol: "openai-responses", models: ["x", "y"], byProtocol: { "openai-chat": ["x"], "openai-responses": ["y"] } });
    expect(redetectDiff(node, [], split, [], "all", { keyScoped: true }).addModels).toEqual(["x"]);
  });

  it("still offers an outdated saved model the account didn't list", () => {
    const listed = found({ models: ["a"] });
    expect(redetectDiff(node, ["a", "old-4"], listed, ["old-4"]).outdatedModels).toEqual([]);
    expect(redetectDiff(node, ["a", "old-4"], listed, ["old-4"], "all", { keyScoped: true })).toMatchObject({ removeModels: [], outdatedModels: ["old-4"] });
  });

  it("offers the API, fixes and routes, but not the URL or removals, from a key's own URL when every key has one", () => {
    const d = redetectDiff(node, ["a", "gone"], r, [], "all", { ownUrl: true });
    expect(d).toMatchObject({ baseUrl: null, removeModels: [], quirks: { apiKeyHeader: "api-key", maxCompletionTokens: true } });
    expect(d.protocol.to).toBe("openai-responses");
    expect(d.quirks.modelRoutes).toEqual({ a: "openai-responses", new: "anthropic" });
    expect(d.modelsNote).not.toBeNull();
    // A fallback key's or one account's list doesn't set the models note.
    expect(redetectDiff(node, ["a"], r, [], "all", { removals: false }).modelsNote).toBeNull();
    expect(redetectDiff(node, ["a"], r, [], "all", { keyScoped: true }).modelsNote).toBeNull();
  });

  it("offers the URL, removals, auth style and routes when not scoped to one key", () => {
    const d = redetectDiff(node, ["a", "gone"], r, [], "all");
    expect(d.baseUrl).toEqual({ from: "https://api.acme.dev/v1", to: "https://acct-1.acme.dev/v1" });
    expect(d.removeModels).toEqual(["gone"]);
    expect(d.quirks.apiKeyHeader).toBe("api-key");
    expect(d.quirks.maxCompletionTokens).toBe(true);
    expect(d.protocol.to).toBe("openai-responses");
    // The control for the scoped case: unscoped, the split is offered as routes.
    expect(d.quirks.modelRoutes).toEqual({ a: "openai-responses", new: "anthropic" });
  });
});

describe("savedSettingsFetch", () => {
  const capture = () => { const seen = []; return { seen, fetchFn: async (url, init) => { seen.push({ url, headers: init.headers }); return { status: 200, text: async () => "" }; } }; };
  it("sends the saved client identity on every probe", async () => {
    const { seen, fetchFn } = capture();
    const f = savedSettingsFetch(fetchFn, { mimic: "codex" });
    await f("https://x.dev/v1/models", { method: "GET", headers: {} });
    await f("https://x.dev/v1/chat/completions", { method: "POST", headers: { authorization: "Bearer sk-1" } });
    for (const s of seen) expect(s.headers["user-agent"]).toMatch(/^codex_cli_rs\//);
    expect(seen[0].headers.Authorization ?? seen[0].headers.authorization).toBeUndefined(); // keyless stays keyless
  });
  it("sends the key the saved way", async () => {
    const { seen, fetchFn } = capture();
    await savedSettingsFetch(fetchFn, { authHeader: "x-api-key" })("https://x.dev/v1/chat/completions", { method: "POST", headers: { authorization: "Bearer sk-1" } });
    expect(seen[0].headers).toEqual({ "x-api-key": "sk-1" });
    await savedSettingsFetch(fetchFn, { apiKeyHeader: "api-key" })("https://x.dev/v1/responses", { method: "POST", headers: { authorization: "Bearer sk-1" } });
    expect(seen[1].headers).toEqual({ "api-key": "sk-1" });
    // apiKeyHeader is OpenAI-only, like the executor: /messages keeps its auth.
    await savedSettingsFetch(fetchFn, { apiKeyHeader: "api-key" })("https://x.dev/v1/messages", { method: "POST", headers: { authorization: "Bearer sk-1", "x-api-key": "sk-1" } });
    expect(seen[2].headers).toEqual({ authorization: "Bearer sk-1", "x-api-key": "sk-1" });
  });
  it("keeps the bad-key check's made-up key when sending it the saved way", async () => {
    const { seen, fetchFn } = capture();
    await savedSettingsFetch(fetchFn, { authHeader: "x-api-key" })("https://x.dev/v1/messages", { method: "POST", headers: { "x-api-key": "made-up" } });
    expect(seen[0].headers).toEqual({ "x-api-key": "made-up" });
    await savedSettingsFetch(fetchFn, { apiKeyHeader: "api-key" })("https://x.dev/v1/chat/completions", { method: "POST", headers: { authorization: "Bearer made-up" } });
    expect(seen[1].headers).toEqual({ "api-key": "made-up" });
  });
  it("can leave the identity out for the client retry", async () => {
    const { seen, fetchFn } = capture();
    await savedSettingsFetch(fetchFn, { mimic: "codex" }, { identity: false })("https://x.dev/v1/models", { method: "GET", headers: { "user-agent": "claude-cli/1" } });
    expect(seen[0].headers["user-agent"]).toBe("claude-cli/1");
  });
});
