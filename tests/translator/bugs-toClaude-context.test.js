// OpenAI-format CLI → Claude provider. Context pollution + lossy mapping on the openai→claude leg.
import { describe, it, expect } from "vitest";
import "./registerAll.js";
import { translateRequest } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { prepareClaudeRequest } from "../../open-sse/translator/formats/claude.js";

// anthropic-compatible provider so prepareClaudeRequest runs the openai→claude path
const T = (body) =>
  translateRequest(FORMATS.OPENAI, FORMATS.CLAUDE, "m", body, true, null, "anthropic-compatible-x");

describe("OpenAI → Claude context mapping", () => {
  it("does not inject Claude Code system prompt for compatible providers", () => {
    const out = T({ messages: [{ role: "user", content: "hi" }] });
    expect(JSON.stringify(out.system ?? null), "Claude Code prompt injected").not.toContain("Claude Code");
  });

  it("still injects the Claude Code prompt for the Claude Code OAuth provider", () => {
    const out = translateRequest(FORMATS.OPENAI, FORMATS.CLAUDE, "m", {
      messages: [{ role: "system", content: "be brief" }, { role: "user", content: "hi" }],
    }, true, null, "claude");
    expect(out.system[0].text).toContain("You are Claude Code");
    expect(out.system.at(-1).text).toBe("be brief");
  });

  it("sends the Claude Code prompt once, as its own first block", () => {
    const CC = "You are Claude Code, Anthropic's official CLI for Claude.";
    const out = translateRequest(FORMATS.OPENAI, FORMATS.CLAUDE, "m", {
      messages: [{ role: "system", content: CC }, { role: "user", content: "hi" }],
    }, true, null, "claude");
    expect(out.system.filter((b) => b.text.includes("Claude Code"))).toHaveLength(1);
    expect(out.system[0].text).toBe(CC);

    const quoted = translateRequest(FORMATS.OPENAI, FORMATS.CLAUDE, "m", {
      messages: [{ role: "system", content: `be brief. ${CC}` }, { role: "user", content: "hi" }],
    }, true, null, "claude");
    expect(quoted.system[0].text).toBe(CC);
  });

  it("adds the Claude Code prompt to Claude-format requests for the Claude Code provider", () => {
    const out = translateRequest(FORMATS.CLAUDE, FORMATS.CLAUDE, "m", {
      system: "be brief", messages: [{ role: "user", content: "hi" }],
    }, true, null, "claude");
    expect(out.system[0].text).toContain("You are Claude Code");
    expect(out.system.at(-1).text).toBe("be brief");
  });

  it("adds the Claude Code prompt for an Anthropic OAuth token on a compatible provider", () => {
    const out = translateRequest(FORMATS.OPENAI, FORMATS.CLAUDE, "m", {
      messages: [{ role: "user", content: "hi" }],
    }, true, { accessToken: "sk-ant-oat01-test" }, "anthropic-compatible-x");
    expect(JSON.stringify(out.system)).toContain("You are Claude Code");
  });

  it("sends no empty system block when the client's system prompt is empty", () => {
    const messages = [{ role: "system", content: "" }, { role: "user", content: "hi" }];
    const plain = translateRequest(FORMATS.OPENAI, FORMATS.CLAUDE, "m", { messages }, true, null, "anthropic-compatible-x");
    expect(plain.system).toBeUndefined();
    const claude = translateRequest(FORMATS.CLAUDE, FORMATS.CLAUDE, "m", {
      system: [{ type: "text", text: "" }], messages: [{ role: "user", content: "hi" }],
    }, true, null, "claude");
    expect(claude.system).toHaveLength(1);
    expect(claude.system[0].text).toContain("You are Claude Code");
  });

  it.each([[""], ["  "], [[{ type: "text", text: "" }]], [[]]])("drops an empty Claude client system %j on a compatible provider", (system) => {
    const out = translateRequest(FORMATS.CLAUDE, FORMATS.CLAUDE, "m", {
      system, messages: [{ role: "user", content: "hi" }],
    }, true, null, "anthropic-compatible-x");
    expect(out.system).toBeUndefined();
  });

  it("keeps non-text system blocks and drops null or blank ones", () => {
    const image = { type: "image", source: { type: "base64", media_type: "image/png", data: "x" } };
    const out = translateRequest(FORMATS.CLAUDE, FORMATS.CLAUDE, "m", {
      system: [null, { type: "text", text: " \n " }, image, { type: "text", text: "real" }],
      messages: [{ role: "user", content: "hi" }],
    }, true, null, "claude");
    expect(out.system.map((b) => b.type)).toEqual(["text", "image", "text"]);
    expect(out.system[0].text).toContain("You are Claude Code");
    expect(out.system[2].text).toBe("real");
  });

  it("sends no system for whitespace-only OpenAI system messages", () => {
    const out = translateRequest(FORMATS.OPENAI, FORMATS.CLAUDE, "m", {
      messages: [{ role: "system", content: "  \n " }, { role: "system", content: "" }, { role: "user", content: "hi" }],
    }, true, null, "anthropic-compatible-x");
    expect(out.system).toBeUndefined();
  });

  it.each(["anthropic", "anthropic-compatible-x"])("does not create unsigned thinking history for %s", (provider) => {
    const body = {
      messages: [
        { role: "user", content: "q" },
        { role: "assistant", content: "a", reasoning_content: "my hidden reasoning" },
        { role: "user", content: "next" },
      ],
    };
    const out = translateRequest(FORMATS.OPENAI, FORMATS.CLAUDE, "m", body, true, null, provider);
    expect(out.messages).toEqual([
      { role: "user", content: [expect.objectContaining({ type: "text", text: "q" })] },
      { role: "assistant", content: [expect.objectContaining({ type: "text", text: "a" })] },
      { role: "user", content: [expect.objectContaining({ type: "text", text: "next" })] },
    ]);
    expect(JSON.stringify(out)).not.toContain("my hidden reasoning");
  });

  it("preserves signed history through Anthropic request preparation", () => {
    const signature = Buffer.from([0x12, 0x01, 0x02]).toString("base64");
    const thinking = { type: "thinking", thinking: "Signed provider history", signature };
    const out = translateRequest(FORMATS.OPENAI, FORMATS.CLAUDE, "m", {
      messages: [
        { role: "user", content: "Question" },
        { role: "assistant", content: [thinking, { type: "text", text: "Answer" }] },
        { role: "user", content: "Follow up" },
      ],
    }, true, null, "anthropic");
    expect(out.messages).toEqual([
      { role: "user", content: [expect.objectContaining({ type: "text", text: "Question" })] },
      { role: "assistant", content: [thinking, expect.objectContaining({ type: "text", text: "Answer" })] },
      { role: "user", content: [expect.objectContaining({ type: "text", text: "Follow up" })] },
    ]);
  });

  // openai-to-claude.js:298 — tool_choice "none" mapped to {type:"auto"} (loses "do not call" intent)
  // KNOWN BUG
  it.fails("tool_choice=none is not turned into auto", () => {
    const out = T({
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: "f", parameters: { type: "object", properties: {} } } }],
      tool_choice: "none",
    });
    expect(out.tool_choice?.type, "none became auto → model may call tools").not.toBe("auto");
  });

  // getContentBlocksFromMessage — no input_audio branch → audio dropped
  // KNOWN BUG
  it.fails("input_audio content is preserved", () => {
    const out = T({
      messages: [{ role: "user", content: [
        { type: "text", text: "transcribe" },
        { type: "input_audio", input_audio: { data: "AUDIO_B64", format: "wav" } },
      ] }],
    });
    expect(JSON.stringify(out), "audio dropped").toContain("AUDIO_B64");
  });

  // openai-to-claude.js:235-251 — remote http image_url is kept (regression guard)
  it("remote http image_url is preserved", () => {
    const out = T({
      messages: [{ role: "user", content: [
        { type: "text", text: "see" },
        { type: "image_url", image_url: { url: "https://x.com/pic.png" } },
      ] }],
    });
    expect(JSON.stringify(out), "remote image dropped").toContain("pic.png");
  });

  // claude.js hasValidContent() — a user message whose content is only an
  // image (no text block) was filtered out by prepareClaudeRequest's
  // "drop empty messages" pass, so an image-only turn (e.g. a vision
  // describe request with no accompanying prompt text in the user message)
  // produced an empty `messages` array and Anthropic rejected the request
  // with "messages: at least one message is required".
  it("user message with only an image is not dropped as empty", () => {
    const out = T({
      messages: [
        { role: "system", content: "Describe the image." },
        { role: "user", content: [
          { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
        ] },
      ],
    });
    expect(out.messages.length, "image-only user message was dropped").toBeGreaterThan(0);
    expect(out.messages[0].content).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "image" })])
    );
  });

  // prepareClaudeRequest reconciles max_tokens vs thinking.budget_tokens.
  // applyThinking runs after adjustMaxTokens caps max_tokens, so a claude-budget
  // model at "max" effort (budget 128000) can exceed the clamped max_tokens and
  // trip Anthropic's "max_tokens > budget_tokens" rule (400). See claude.js.
  describe("max_tokens vs thinking.budget_tokens reconciliation", () => {
    // 64k-ceiling model (maxOutput 64000) + max-effort budget 128000: budget alone
    // exceeds the ceiling → cap max_tokens at 64000 and shrink budget below it.
    it("max effort budget on a 64k model → budget < max_tokens ≤ 64000", () => {
      const out = prepareClaudeRequest({
        model: "claude-opus-4-20250514",
        max_tokens: 64000,
        thinking: { type: "enabled", budget_tokens: 128000 },
        messages: [{ role: "user", content: "q" }],
      }, "anthropic");
      expect(out.max_tokens).toBe(64000);
      expect(out.thinking.budget_tokens).toBeLessThan(out.max_tokens);
      expect(out.thinking.budget_tokens).toBeGreaterThan(0);
    });

    // Budget fits under the ceiling but exceeds a small client max_tokens →
    // raise max_tokens to fit, preserving the requested thinking depth.
    it("xhigh budget with a low client max_tokens → raise max_tokens, preserve budget", () => {
      const out = prepareClaudeRequest({
        model: "claude-opus-4-20250514",
        max_tokens: 16000,
        thinking: { type: "enabled", budget_tokens: 32768 },
        messages: [{ role: "user", content: "q" }],
      }, "anthropic");
      expect(out.thinking.budget_tokens).toBe(32768);
      expect(out.max_tokens).toBe(33792); // 32768 + 1024, under the 64000 ceiling
    });

    // Budget already below max_tokens → nothing to reconcile.
    it("high budget under max_tokens → both unchanged", () => {
      const out = prepareClaudeRequest({
        model: "claude-opus-4-20250514",
        max_tokens: 64000,
        thinking: { type: "enabled", budget_tokens: 24576 },
        messages: [{ role: "user", content: "q" }],
      }, "anthropic");
      expect(out.max_tokens).toBe(64000);
      expect(out.thinking.budget_tokens).toBe(24576);
    });

    // Non-budget thinking shapes (adaptive / disabled) carry no budget_tokens →
    // the reconciliation must never touch them.
    it("adaptive thinking (no budget_tokens) is left untouched", () => {
      const out = prepareClaudeRequest({
        model: "claude-opus-4-20250514",
        max_tokens: 64000,
        thinking: { type: "adaptive" },
        messages: [{ role: "user", content: "q" }],
      }, "anthropic");
      expect(out.max_tokens).toBe(64000);
      expect(out.thinking).toEqual({ type: "adaptive" });
    });

    // Lifted ceiling: a claude-budget model whose caps declare maxOutput 128000
    // (e.g. fable) may use the full budget at max effort instead of being pinned
    // to the conservative 64000 default.
    it("max effort budget on a 128k model → max_tokens up to 128000, budget preserved just under", () => {
      const out = prepareClaudeRequest({
        model: "claude-fable-5",
        max_tokens: 64000,
        thinking: { type: "enabled", budget_tokens: 128000 },
        messages: [{ role: "user", content: "q" }],
      }, "anthropic");
      expect(out.max_tokens).toBe(128000);
      expect(out.thinking.budget_tokens).toBe(126976); // 128000 - 1024
      expect(out.thinking.budget_tokens).toBeLessThan(out.max_tokens);
    });

    // Regression: a default 64k-ceiling model still clamps an over-large client
    // max_tokens down to 64000 (the lift is per-model, not global).
    it("over-large client max_tokens on a 64k model is still clamped to 64000", () => {
      const out = prepareClaudeRequest({
        model: "claude-opus-4-20250514",
        max_tokens: 120000,
        messages: [{ role: "user", content: "q" }],
      }, "anthropic");
      expect(out.max_tokens).toBe(64000);
    });

    // Lifted ceiling for a 128k model: a large client max_tokens is now allowed
    // through instead of being clamped to 64000.
    it("large client max_tokens on a 128k model is allowed up to maxOutput", () => {
      const out = prepareClaudeRequest({
        model: "claude-fable-5",
        max_tokens: 100000,
        messages: [{ role: "user", content: "q" }],
      }, "anthropic");
      expect(out.max_tokens).toBe(100000);
    });
  });

  it("DeepSeek Claude transport adds a thinking placeholder before tool_use in thinking mode", () => {
    const out = prepareClaudeRequest({
      model: "deepseek-v4-pro",
      thinking: { type: "enabled" },
      messages: [
        { role: "user", content: [{ type: "text", text: "q" }] },
        { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "x" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }] },
        { role: "user", content: [{ type: "text", text: "continue" }] },
      ],
    }, "deepseek");

    const assistant = out.messages.find((m) => m.role === "assistant");
    expect(assistant.content[0]).toEqual({ type: "thinking", thinking: "." });
    expect(assistant.content[1]).toEqual(expect.objectContaining({ type: "tool_use", id: "toolu_1" }));
    expect(assistant.content[0].signature).toBeUndefined();
  });

  it("still adds the placeholder when Claude Code's trailing system reminder follows the tool_result", () => {
    const out = prepareClaudeRequest({
      model: "deepseek-v4-pro",
      thinking: { type: "enabled" },
      messages: [
        { role: "user", content: [{ type: "text", text: "q" }] },
        { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "x" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }] },
        { role: "system", content: "<system-reminder>x</system-reminder>" },
      ],
    }, "deepseek");

    const assistant = out.messages.find((m) => m.role === "assistant");
    expect(assistant.content[0]).toEqual({ type: "thinking", thinking: "." });
  });

  it("does not add the placeholder when an assistant turn comes before the trailing system reminder", () => {
    const out = prepareClaudeRequest({
      model: "deepseek-v4-pro",
      thinking: { type: "enabled" },
      messages: [
        { role: "user", content: [{ type: "text", text: "q" }] },
        { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "x" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }] },
        { role: "assistant", content: [{ type: "text", text: "partial" }] },
        { role: "system", content: "<system-reminder>x</system-reminder>" },
      ],
    }, "deepseek");

    const toolTurn = out.messages.find((m) => m.role === "assistant" && m.content.some((b) => b.type === "tool_use"));
    expect(toolTurn.content[0].type).toBe("tool_use");
  });
});
