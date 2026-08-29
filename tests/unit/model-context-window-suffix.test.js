import { describe, expect, it } from "vitest";

import { parseModel, stripContextWindowSuffix } from "../../open-sse/services/model.js";

// Anthropic clients request an explicit context window by appending a bracketed
// suffix to the model id ("claude-opus-5[1m]"). The suffix is a client-side
// selector, not a catalogue id, so routing must strip it. Left in place the id
// matches no alias, falls through to prefix inference, and 404s against the bare
// "anthropic" provider.
describe("context-window model id suffix", () => {
  describe("stripContextWindowSuffix", () => {
    it("splits the selector off the model id", () => {
      expect(stripContextWindowSuffix("claude-opus-5[1m]")).toEqual({
        model: "claude-opus-5",
        contextWindow: "1m",
      });
    });

    it("normalizes the selector to lower case", () => {
      expect(stripContextWindowSuffix("claude-opus-5[1M]")).toEqual({
        model: "claude-opus-5",
        contextWindow: "1m",
      });
    });

    it("leaves ids without a selector untouched", () => {
      expect(stripContextWindowSuffix("claude-opus-5")).toEqual({
        model: "claude-opus-5",
        contextWindow: null,
      });
    });

    it("ignores brackets that are not a context-window selector", () => {
      expect(stripContextWindowSuffix("weird[abc]")).toEqual({
        model: "weird[abc]",
        contextWindow: null,
      });
    });

    it("tolerates an empty model id", () => {
      expect(stripContextWindowSuffix("")).toEqual({ model: "", contextWindow: null });
    });
  });

  describe("parseModel", () => {
    for (const model of [
      "claude-opus-5",
      "claude-opus-4-8",
      "claude-fable-5",
      "claude-sonnet-5",
    ]) {
      it(`routes ${model}[1m] the same as ${model}`, () => {
        expect(parseModel(`${model}[1m]`)).toEqual({ ...parseModel(model), contextWindow: "1m" });
      });
    }

    it("strips the selector behind a provider prefix", () => {
      expect(parseModel("anthropic/claude-opus-5[1m]")).toMatchObject({
        provider: "anthropic",
        model: "claude-opus-5",
        contextWindow: "1m",
      });
    });

    it("keeps a 200k selector routable too", () => {
      expect(parseModel("claude-sonnet-5[200k]")).toMatchObject({
        model: "claude-sonnet-5",
        contextWindow: "200k",
      });
    });

    it("reports no context window when the id carries no selector", () => {
      expect(parseModel("claude-opus-5").contextWindow).toBeNull();
    });

    it("does not disturb non-Claude ids", () => {
      expect(parseModel("ocg/glm-5.2")).toMatchObject({
        model: "glm-5.2",
        contextWindow: null,
      });
    });
  });
});
