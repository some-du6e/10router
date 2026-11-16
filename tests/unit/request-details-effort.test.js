import { describe, expect, it } from "vitest";

import { extractRequestConfig } from "../../open-sse/handlers/chatCore/requestDetail.js";

const messages = [{ role: "user", content: "hi" }];

describe("extractRequestConfig keeps the client's reasoning effort", () => {
  it("keeps Claude output_config", () => {
    const config = extractRequestConfig({
      model: "claude-sonnet-x",
      messages,
      thinking: { type: "adaptive" },
      output_config: { effort: "max" },
    }, true);
    expect(config.output_config).toEqual({ effort: "max" });
    expect(config.thinking).toEqual({ type: "adaptive" });
  });

  it("keeps OpenAI chat reasoning_effort", () => {
    const config = extractRequestConfig({ model: "gpt-x", messages, reasoning_effort: "low" }, false);
    expect(config).toEqual({ model: "gpt-x", stream: false, messages, reasoning_effort: "low" });
  });

  it("keeps Gemini thinkingConfig and generationConfig", () => {
    const generationConfig = { temperature: 0.2, thinkingConfig: { thinkingBudget: 1024 } };
    const config = extractRequestConfig({
      model: "gemini-x",
      thinkingConfig: { thinkingLevel: "high" },
      generationConfig,
    }, false);
    expect(config.thinkingConfig).toEqual({ thinkingLevel: "high" });
    expect(config.generationConfig).toEqual(generationConfig);
  });

  it("keeps Qwen thinking_budget next to enable_thinking", () => {
    const config = extractRequestConfig({
      model: "qwen-x",
      messages,
      enable_thinking: true,
      thinking_budget: 2048,
    }, false);
    expect(config.enable_thinking).toBe(true);
    expect(config.thinking_budget).toBe(2048);
  });

  it("leaves the fields out when the client didn't send them", () => {
    const config = extractRequestConfig({ model: "claude-sonnet-x", messages }, true);
    expect(config).toEqual({ model: "claude-sonnet-x", stream: true, messages });
  });
});
