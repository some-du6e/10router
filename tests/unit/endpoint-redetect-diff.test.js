// Re-detect on the endpoint page: what changed since the endpoint was added.
import { describe, expect, it } from "vitest";
import { redetectDiff, modelsNoteFor } from "../../src/app/api/providers/[id]/redetect/diff.ts";

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
  it("passes a failure through", () => {
    expect(redetectDiff(node, [], { ok: false, error: "401", steps: [] })).toMatchObject({ ok: false, error: "401", changes: 0 });
  });
  it("writes the models source note", () => {
    expect(modelsNoteFor({ modelsSource: "models", models: ["a"] })).toBe("imported from /models (1 model)");
    expect(modelsNoteFor({ modelsSource: "catalog", models: [] })).toMatch(/models\.dev/);
    expect(modelsNoteFor({ modelsSource: "none", models: [] })).toBeNull();
  });
});
