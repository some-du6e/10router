import { describe, expect, it } from "vitest";
import { calculateCostFromTokens, getPricingForModel } from "../../open-sse/providers/pricing.js";

describe("GPT-6 context pricing", () => {
  it.each([
    ["gpt-6-astra", 10, 50, 20, 75],
    ["gpt-6-sol", 2, 10, 4, 15],
    ["gpt-6-luna", 0.1, 0.5, 0.2, 0.75],
  ])("selects whole-request rates at the threshold for %s", (model, input, output, longInput, longOutput) => {
    const pricing = getPricingForModel("openai", model);
    expect(calculateCostFromTokens({ prompt_tokens: 272000, completion_tokens: 1000 }, pricing))
      .toBeCloseTo((272000 * input + 1000 * output) / 1000000);
    expect(calculateCostFromTokens({ prompt_tokens: 272001, completion_tokens: 1000 }, pricing))
      .toBeCloseTo((272001 * longInput + 1000 * longOutput) / 1000000);
    expect(pricing.input).toBe(input);
  });

  it("counts cached input toward the threshold and applies all tier rates", () => {
    const cost = calculateCostFromTokens({
      input_tokens: 300000, cached_tokens: 200000, cache_creation_input_tokens: 10000,
      output_tokens: 1000, reasoning_tokens: 100,
    }, getPricingForModel("openai", "gpt-6-sol"));
    expect(cost).toBeCloseTo(0.5065);
  });

  it("preserves custom flat rates without a context tier", () => {
    expect(calculateCostFromTokens({ prompt_tokens: 300000, completion_tokens: 1000 }, { input: 1, output: 2 }))
      .toBeCloseTo(0.302);
  });
});
