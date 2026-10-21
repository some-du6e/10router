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
    expect(d.quirks.modelRoutes).toMatchObject({ "claude-a": "anthropic", "claude-b": "anthropic" });
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
  it("offers clearing stale routes once the endpoint no longer splits models", () => {
    const saved = { ...node, modelRoutes: { "claude-a": "anthropic" } };
    const r = found({ modelsSource: "guessed", models: ["claude-a", "gpt-x"], byProtocol: { "openai-chat": ["claude-a", "gpt-x"] } });
    expect(redetectDiff(saved, ["claude-a", "gpt-x"], r).quirks.modelRoutes).toEqual({});
    expect(redetectDiff(saved, ["claude-a", "gpt-x"], { ...r, partial: true }).quirks.modelRoutes).toBeUndefined();
    expect(redetectDiff(node, ["claude-a", "gpt-x"], r).quirks.modelRoutes).toBeUndefined();
    // Listed via /models (no per-API probing): routes left alone.
    expect(redetectDiff(saved, ["a", "b"], found()).quirks.modelRoutes).toBeUndefined();
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

describe("savedSettingsFetch", () => {
  const capture = () => { const seen = []; return { seen, fetchFn: async (url, init) => { seen.push({ url, headers: init.headers }); return { status: 200, text: async () => "" }; } }; };
  it("sends the saved client identity on every probe", async () => {
    const { seen, fetchFn } = capture();
    const f = savedSettingsFetch(fetchFn, { mimic: "codex" }, "sk-1");
    await f("https://x.dev/v1/models", { method: "GET", headers: {} });
    await f("https://x.dev/v1/chat/completions", { method: "POST", headers: { authorization: "Bearer sk-1" } });
    for (const s of seen) expect(s.headers["user-agent"]).toMatch(/^codex_cli_rs\//);
    expect(seen[0].headers.Authorization ?? seen[0].headers.authorization).toBeUndefined(); // keyless stays keyless
  });
  it("sends the key the saved way", async () => {
    const { seen, fetchFn } = capture();
    await savedSettingsFetch(fetchFn, { authHeader: "x-api-key" }, "sk-1")("https://x.dev/v1/chat/completions", { method: "POST", headers: { authorization: "Bearer sk-1" } });
    expect(seen[0].headers).toEqual({ "x-api-key": "sk-1" });
    await savedSettingsFetch(fetchFn, { apiKeyHeader: "api-key" }, "sk-1")("https://x.dev/v1/responses", { method: "POST", headers: { authorization: "Bearer sk-1" } });
    expect(seen[1].headers).toEqual({ "api-key": "sk-1" });
    // apiKeyHeader is OpenAI-only, like the executor: /messages keeps its auth.
    await savedSettingsFetch(fetchFn, { apiKeyHeader: "api-key" }, "sk-1")("https://x.dev/v1/messages", { method: "POST", headers: { authorization: "Bearer sk-1", "x-api-key": "sk-1" } });
    expect(seen[2].headers).toEqual({ authorization: "Bearer sk-1", "x-api-key": "sk-1" });
  });
  it("can leave the identity out for the client retry", async () => {
    const { seen, fetchFn } = capture();
    await savedSettingsFetch(fetchFn, { mimic: "codex" }, "sk-1", { identity: false })("https://x.dev/v1/models", { method: "GET", headers: { "user-agent": "claude-cli/1" } });
    expect(seen[0].headers["user-agent"]).toBe("claude-cli/1");
  });
});
