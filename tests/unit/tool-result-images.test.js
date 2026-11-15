// A screenshot in a tool result (a computer-use or browser tool) reaches every
// target as an image, or as a short placeholder. Its base64 never goes upstream
// as text, where it would cost hundreds of thousands of tokens per image.
import { describe, it, expect } from "vitest";
import { translateRequest } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { openaiResponsesToOpenAIRequest } from "../../open-sse/translator/request/openai-responses.js";
import { convertResponsesApiFormat } from "../../open-sse/translator/formats/responsesApi.js";
import { filterToOpenAIFormat } from "../../open-sse/translator/formats/openai.js";
import {
  scrubInlineBase64,
  splitToolContent,
  toolContentText,
  moveToolImagesToUserTurn,
} from "../../open-sse/translator/concerns/toolContent.js";
import { stripUnsupportedModalities } from "../../open-sse/translator/concerns/modality.js";
import { estimateInputTokens, estimateBillingInputTokens } from "../../open-sse/utils/usageTracking.js";
import { estimateAnthropicInputTokens } from "../../src/app/api/v1/messages/count_tokens/route.js";
import { capChatImages, capClaudeImages, planImageWindow } from "../../open-sse/translator/concerns/toolImageCap.js";
import { imageDimensions } from "../../open-sse/translator/concerns/image.js";
import { GrokCliExecutor } from "../../open-sse/executors/grok-cli.js";
import { clearKiroSessionReplayStore } from "../../open-sse/utils/kiroSessionReplay.js";
import { MEDIA_OMITTED_TEXT, IMAGE_TOKEN_ESTIMATE, IMAGE_WINDOW } from "../../open-sse/config/mediaConfig.js";

// 1x1 PNG / JPEG placeholders
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const JPEG_B64 = "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAAA//EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AN//Z";
const PNG_URL = `data:image/png;base64,${PNG_B64}`;
const JPEG_URL = `data:image/jpeg;base64,${JPEG_B64}`;
// Screenshot-sized payloads, for the text guard and the estimators
const BIG_B64 = "A".repeat(200_000);
const BIG_JPEG_B64 = `/9j/4AAQ${BIG_B64}`; // a JPEG header, so it passes the type sniff
const CLAUDE_MODEL = "claude-sonnet-4-5";

const screenshotOutput = (url = JPEG_URL) => [
  { type: "input_text", text: "Output:" },
  { type: "input_image", image_url: url, detail: "auto" },
];

// A Responses turn: the model called a tool, the tool returned a screenshot.
const responsesBody = (output = screenshotOutput(), { calls = 1, itemType = "function_call_output" } = {}) => {
  const input = [{ type: "message", role: "user", content: [{ type: "input_text", text: "take a screenshot" }] }];
  for (let i = 1; i <= calls; i++) {
    input.push({ type: "function_call", call_id: `call_${i}`, name: "screenshot", arguments: "{}" });
  }
  for (let i = 1; i <= calls; i++) {
    input.push({ type: itemType, call_id: `call_${i}`, output });
  }
  return {
    model: CLAUDE_MODEL,
    input,
    tools: [{ type: "function", name: "screenshot", parameters: { type: "object", properties: {} } }],
  };
};

// Remove the fields where an image belongs, so anything left is text.
const IMAGE_KEYS = new Set(["image_url", "inlineData", "inline_data", "images", "fileData"]);
function withoutImageFields(value) {
  if (Array.isArray(value)) return value.map(withoutImageFields);
  if (!value || typeof value !== "object") return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (IMAGE_KEYS.has(k)) continue;
    if (k === "source" && v && typeof v === "object" && (v.type === "base64" || v.type === "url" || "bytes" in v)) continue;
    out[k] = withoutImageFields(v);
  }
  return out;
}
const leaksIntoText = (body, b64) => JSON.stringify(withoutImageFields(body)).includes(b64);

const toolMessages = (body) => body.messages.filter((m) => m.role === "tool");

describe("Responses → OpenAI pivot, both converters", () => {
  const converters = [
    ["openaiResponsesToOpenAIRequest", (body) => openaiResponsesToOpenAIRequest(CLAUDE_MODEL, body, true, null)],
    ["convertResponsesApiFormat", (body) => convertResponsesApiFormat(body)],
  ];

  for (const [name, convert] of converters) {
    it(`${name}: an array output becomes text + image_url parts, not a JSON string`, () => {
      const out = convert(responsesBody());
      const [tool] = toolMessages(out);
      expect(tool.tool_call_id).toBe("call_1");
      expect(tool.content).toEqual([
        { type: "text", text: "Output:" },
        { type: "image_url", image_url: { url: JPEG_URL, detail: "auto" } },
      ]);
      expect(leaksIntoText(out, JPEG_B64)).toBe(false);
    });

    it(`${name}: a string output is unchanged`, () => {
      const out = convert(responsesBody("exit code 0\nhello"));
      expect(toolMessages(out)[0].content).toBe("exit code 0\nhello");
    });

    it(`${name}: image_url given as { url } is read too`, () => {
      const out = convert(responsesBody([{ type: "input_image", image_url: { url: PNG_URL } }]));
      expect(toolMessages(out)[0].content).toEqual([{ type: "image_url", image_url: { url: PNG_URL, detail: "auto" } }]);
    });
  }

  it("custom_tool_call_output arrays are converted the same way", () => {
    const out = openaiResponsesToOpenAIRequest(CLAUDE_MODEL, responsesBody(screenshotOutput(), { itemType: "custom_tool_call_output" }), true, null);
    expect(toolMessages(out)[0].content[1].type).toBe("image_url");
  });

  it("parts that can't be an image become placeholders, never base64 text", () => {
    const out = openaiResponsesToOpenAIRequest(CLAUDE_MODEL, responsesBody([
      { type: "input_image", file_id: "file_1" },
      { type: "input_file", file_data: `data:application/pdf;base64,${BIG_B64}` },
      { type: "input_text", text: `inline ${`data:image/png;base64,${BIG_B64}`} end` },
      { type: "some_future_part" },
    ]), true, null);
    // No image left, so one string (the shape strict Chat upstreams take)
    expect(toolMessages(out)[0].content).toBe([
      MEDIA_OMITTED_TEXT.IMAGE,
      MEDIA_OMITTED_TEXT.FILE,
      `inline ${MEDIA_OMITTED_TEXT.IMAGE} end`,
      MEDIA_OMITTED_TEXT.OTHER,
    ].join("\n"));
    expect(JSON.stringify(out)).not.toContain(BIG_B64);
  });

  it("a text-only array output becomes one joined string", () => {
    const out = openaiResponsesToOpenAIRequest(CLAUDE_MODEL, responsesBody([
      { type: "input_text", text: "a" },
      { type: "output_text", text: "b" },
    ]), true, null);
    expect(toolMessages(out)[0].content).toBe("a\nb");
  });

  it("a string output gets the same scrub as array text", () => {
    const out = convertResponsesApiFormat(responsesBody(`{"shot":"data:image/png;base64,${BIG_B64}"}`));
    expect(toolMessages(out)[0].content).toBe(`{"shot":"${MEDIA_OMITTED_TEXT.IMAGE}"}`);
  });
});

describe("Responses → Claude through translateRequest", () => {
  const toClaude = (body) => translateRequest(FORMATS.OPENAI_RESPONSES, FORMATS.CLAUDE, CLAUDE_MODEL, body, true, null, null);
  const toolResults = (out) => out.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : []))
    .filter((b) => b.type === "tool_result");

  it("the tool_result holds a text block and a base64 image block with the right media type", () => {
    const out = toClaude(responsesBody());
    const [result] = toolResults(out);
    expect(result.tool_use_id).toBe("call_1");
    expect(result).not.toHaveProperty("is_error");
    expect(result.content).toEqual([
      { type: "text", text: "Output:" },
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: JPEG_B64 } },
    ]);
    expect(leaksIntoText(out, JPEG_B64)).toBe(false);
  });

  it("an https image becomes a url source", () => {
    const out = toClaude(responsesBody([{ type: "input_image", image_url: "https://example.com/shot.png" }]));
    expect(toolResults(out)[0].content).toEqual([{ type: "image", source: { type: "url", url: "https://example.com/shot.png" } }]);
  });

  it("a string tool output stays a string", () => {
    const out = toClaude(responsesBody("plain result"));
    expect(toolResults(out)[0].content).toBe("plain result");
  });

  it("is_error on a Claude tool_result part is kept, and its id matches", () => {
    const out = translateRequest(FORMATS.OPENAI, FORMATS.CLAUDE, CLAUDE_MODEL, {
      messages: [
        { role: "user", content: "go" },
        { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "screenshot", arguments: "{}" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "boom", is_error: true }] },
      ],
    }, true, null, null);
    const [result] = toolResults(out);
    expect(result).toMatchObject({ tool_use_id: "call_1", is_error: true, content: "boom" });
  });

  it("input_image in a user message becomes a Claude image block", () => {
    const out = toClaude({
      model: CLAUDE_MODEL,
      input: [{ type: "message", role: "user", content: [
        { type: "input_text", text: "what is this?" },
        { type: "input_image", image_url: PNG_URL },
      ] }],
    });
    const user = out.messages.find((m) => m.role === "user");
    expect(user.content).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "text", text: "what is this?" }),
      expect.objectContaining({ type: "image", source: { type: "base64", media_type: "image/png", data: PNG_B64 } }),
    ]));
  });

  it("a user input_image with only a file_id becomes a placeholder, not a url", () => {
    const out = openaiResponsesToOpenAIRequest(CLAUDE_MODEL, {
      input: [{ type: "message", role: "user", content: [{ type: "input_image", file_id: "file_1" }] }],
    }, true, null);
    expect(out.messages[0].content).toEqual([{ type: "text", text: MEDIA_OMITTED_TEXT.IMAGE }]);
  });

  it("native Claude passthrough (claude → claude) keeps its image tool_result as it is", () => {
    const content = [
      { type: "text", text: "Output:" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: PNG_B64 } },
    ];
    const out = translateRequest(FORMATS.CLAUDE, FORMATS.CLAUDE, CLAUDE_MODEL, {
      model: CLAUDE_MODEL,
      max_tokens: 1024,
      messages: [
        { role: "user", content: "go" },
        { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "screenshot", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content }] },
      ],
    }, true, null, null);
    const [result] = toolResults(out);
    expect(result.content).toEqual(content);
  });
});

describe("OpenAI Chat targets", () => {
  const toOpenAI = (body) => translateRequest(FORMATS.OPENAI_RESPONSES, FORMATS.OPENAI, "gpt-x", body, true, null, null);

  it("the tool message keeps the text, and the image goes in a user message right after", () => {
    const out = toOpenAI(responsesBody());
    const i = out.messages.findIndex((m) => m.role === "tool");
    expect(out.messages[i]).toEqual({ role: "tool", tool_call_id: "call_1", content: "Output:\n[image 1 attached below]" });
    expect(out.messages[i + 1]).toEqual({ role: "user", content: [{ type: "image_url", image_url: { url: JPEG_URL, detail: "auto" } }] });
    expect(leaksIntoText(out, JPEG_B64)).toBe(false);
  });

  it("several tool results in a row get ONE user message after the last of them", () => {
    const out = toOpenAI(responsesBody(screenshotOutput(), { calls: 3 }));
    const roles = out.messages.map((m) => m.role);
    expect(roles).toEqual(["user", "assistant", "tool", "tool", "tool", "user"]);
    expect(out.messages.slice(2, 5).map((m) => m.tool_call_id)).toEqual(["call_1", "call_2", "call_3"]);
    expect(out.messages[2].content).toBe("Output:\n[image 1 attached below]");
    expect(out.messages[4].content).toBe("Output:\n[image 3 attached below]");
    expect(out.messages[5].content).toHaveLength(3);
    // every tool_call is answered before any other message
    const asst = out.messages[1];
    expect(asst.tool_calls.map((c) => c.id)).toEqual(["call_1", "call_2", "call_3"]);
  });

  it("an image-only tool result gets a note in its place", () => {
    const out = toOpenAI(responsesBody([{ type: "input_image", image_url: PNG_URL }]));
    expect(toolMessages(out)[0].content).toBe("[image 1 attached below]");
  });

  it("a text-only tool message is unchanged, byte for byte", () => {
    const messages = [
      { role: "user", content: "go" },
      { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "screenshot", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "call_1", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] },
      { role: "tool", tool_call_id: "call_2", content: "plain" },
    ];
    const before = JSON.stringify(messages);
    expect(moveToolImagesToUserTurn(messages)).toBe(messages);
    const out = filterToOpenAIFormat({ messages: structuredClone(messages) });
    expect(JSON.stringify(out.messages.filter((m) => m.role === "tool"))).toBe(JSON.stringify(JSON.parse(before).filter((m) => m.role === "tool")));
  });

  it("Chat → Responses target: an image tool result becomes an input_text + input_image output array", () => {
    const out = translateRequest(FORMATS.OPENAI, FORMATS.OPENAI_RESPONSES, "gpt-x", {
      messages: [
        { role: "user", content: "go" },
        { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "screenshot", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "call_1", content: [{ type: "text", text: "Output:" }, { type: "image_url", image_url: { url: PNG_URL } }] },
      ],
    }, true, null, null);
    const item = out.input.find((i) => i.type === "function_call_output");
    expect(item.output).toEqual([
      { type: "input_text", text: "Output:" },
      { type: "input_image", image_url: PNG_URL, detail: "auto" },
    ]);
  });
});

describe("other targets reached through the OpenAI pivot", () => {
  const targets = [
    [FORMATS.GEMINI, "gemini-x"],
    [FORMATS.GEMINI_CLI, "gemini-x"],
    [FORMATS.VERTEX, "gemini-x"],
    [FORMATS.ANTIGRAVITY, "gemini-x"],
    [FORMATS.ANTIGRAVITY, CLAUDE_MODEL],
    [FORMATS.KIRO, CLAUDE_MODEL],
    [FORMATS.CURSOR, "cursor-x"],
    [FORMATS.OLLAMA, "ollama-x"],
    [FORMATS.COMMANDCODE, "commandcode-x"],
  ];

  for (const [target, model] of targets) {
    it(`${target} (${model}): no throw, and no base64 in any text field`, () => {
      const body = responsesBody(screenshotOutput(), { calls: 2 });
      let out;
      expect(() => { out = translateRequest(FORMATS.OPENAI_RESPONSES, target, model, body, true, {}, null); }).not.toThrow();
      expect(out).toBeTruthy();
      expect(leaksIntoText(out, JPEG_B64)).toBe(false);
    });
  }

  it("Gemini carries the image as inlineData after the functionResponse", () => {
    const out = translateRequest(FORMATS.OPENAI_RESPONSES, FORMATS.GEMINI, "gemini-x", responsesBody(), true, null, null);
    const turn = out.contents.find((c) => c.parts.some((p) => p.functionResponse));
    expect(turn.parts[0].functionResponse.response.result).toEqual({ result: "Output:\n[image 1 attached below]" });
    expect(turn.parts[1]).toEqual({ inlineData: { mime_type: "image/jpeg", data: JPEG_B64 } });
  });

  it("Gemini numbers the notes across several results in one turn", () => {
    const out = translateRequest(FORMATS.OPENAI_RESPONSES, FORMATS.GEMINI, "gemini-x", responsesBody(screenshotOutput(), { calls: 2 }), true, null, null);
    const turn = out.contents.find((c) => c.parts.some((p) => p.functionResponse));
    const results = turn.parts.filter((p) => p.functionResponse).map((p) => p.functionResponse.response.result.result);
    expect(results).toEqual(["Output:\n[image 1 attached below]", "Output:\n[image 2 attached below]"]);
    expect(turn.parts.filter((p) => p.inlineData)).toHaveLength(2);
  });

  it("Antigravity's Claude envelope carries the image as inlineData too", () => {
    const out = translateRequest(FORMATS.OPENAI_RESPONSES, FORMATS.ANTIGRAVITY, CLAUDE_MODEL, responsesBody(), true, {}, null);
    const parts = out.request.contents.flatMap((c) => c.parts);
    expect(parts.find((p) => p.functionResponse).functionResponse.response.result).toBe("Output:\n[image 1 attached below]");
    expect(parts).toContainEqual({ inlineData: { mime_type: "image/jpeg", data: JPEG_B64 } });
  });

  const kiroTurn = (out) => out.conversationState.currentMessage.userInputMessage;
  const kiroToolTexts = (out) => kiroTurn(out).userInputMessageContext.toolResults.map((r) => r.content[0].text);

  it("Kiro keeps the tool text and sends the image as an image", () => {
    const out = translateRequest(FORMATS.OPENAI_RESPONSES, FORMATS.KIRO, CLAUDE_MODEL, responsesBody(), true, {}, null);
    expect(kiroToolTexts(out)).toEqual(["Output:\n[image 1 attached below]"]);
    expect(kiroTurn(out).images).toEqual([{ format: "jpeg", source: { bytes: JPEG_B64 } }]);
    expect(leaksIntoText(out, JPEG_B64)).toBe(false);
  });

  it("Kiro numbers the notes across tool results folded into one turn", () => {
    const out = translateRequest(FORMATS.OPENAI_RESPONSES, FORMATS.KIRO, CLAUDE_MODEL, responsesBody(screenshotOutput(), { calls: 2 }), true, {}, null);
    expect(kiroToolTexts(out)).toEqual(["Output:\n[image 1 attached below]", "Output:\n[image 2 attached below]"]);
    expect(kiroTurn(out).images).toHaveLength(2);
  });

  it("Kiro keeps an https screenshot as its URL, since it attaches base64 only", () => {
    const out = translateRequest(FORMATS.OPENAI_RESPONSES, FORMATS.KIRO, CLAUDE_MODEL,
      responsesBody([{ type: "input_text", text: "Output:" }, { type: "input_image", image_url: "https://example.com/shot.png" }]), true, {}, null);
    expect(kiroToolTexts(out)).toEqual(["Output:\n[Image: https://example.com/shot.png]"]);
    expect(kiroTurn(out).images).toBeUndefined();
  });

  it("the direct claude → Kiro route attaches an image-only tool_result as a Kiro image", () => {
    const out = translateRequest(FORMATS.CLAUDE, FORMATS.KIRO, CLAUDE_MODEL, {
      model: CLAUDE_MODEL,
      max_tokens: 1024,
      tools: [{ name: "screenshot", description: "Take a screenshot", input_schema: { type: "object", properties: {} } }],
      messages: [
        { role: "user", content: "go" },
        { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "screenshot", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: [
          { type: "image", source: { type: "base64", media_type: "image/png", data: PNG_B64 } },
        ] }] },
      ],
    }, true, {}, null);
    expect(kiroToolTexts(out)).toEqual(["[image 1 attached below]"]);
    expect(kiroTurn(out).images).toEqual([{ format: "png", source: { bytes: PNG_B64 } }]);
    expect(leaksIntoText(out, PNG_B64)).toBe(false);
  });

  it("Kiro reads an image_url given as a bare string", () => {
    const out = translateRequest(FORMATS.OPENAI, FORMATS.KIRO, CLAUDE_MODEL, {
      messages: [
        { role: "user", content: "go" },
        { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "screenshot", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "call_1", content: [{ type: "text", text: "Output:" }, { type: "image_url", image_url: PNG_URL }] },
      ],
    }, true, {}, null);
    expect(JSON.stringify(out)).toContain(PNG_B64);
    expect(leaksIntoText(out, PNG_B64)).toBe(false);
  });

  it("Ollama sends the image in images[] on a user message after the tool message", () => {
    const out = translateRequest(FORMATS.OPENAI_RESPONSES, FORMATS.OLLAMA, "ollama-x", responsesBody(), true, null, null);
    const i = out.messages.findIndex((m) => m.role === "tool");
    expect(out.messages[i].content).toBe("Output:\n[image 1 attached below]");
    expect(out.messages[i + 1]).toMatchObject({ role: "user", images: [JPEG_B64] });
  });

  it("Ollama takes base64 only: an https screenshot stays as its URL, not a dangling note", () => {
    const out = translateRequest(FORMATS.OPENAI_RESPONSES, FORMATS.OLLAMA, "ollama-x",
      responsesBody([{ type: "input_text", text: "Output:" }, { type: "input_image", image_url: "https://example.com/shot.png" }]), true, null, null);
    const i = out.messages.findIndex((m) => m.role === "tool");
    expect(out.messages[i].content).toBe("Output:\n[Image: https://example.com/shot.png]");
    expect(out.messages[i + 1]).toBeUndefined();
  });
});

describe("text guard", () => {
  it("replaces large image and PDF data URLs only; bare base64 and small ones stay", () => {
    expect(scrubInlineBase64(`a data:image/jpeg;base64,${BIG_B64} b`)).toBe(`a ${MEDIA_OMITTED_TEXT.IMAGE} b`);
    expect(scrubInlineBase64(`a data:application/pdf;base64,${BIG_B64} b`)).toBe(`a ${MEDIA_OMITTED_TEXT.FILE} b`);
    expect(scrubInlineBase64(`raw ${BIG_B64}`)).toBe(`raw ${BIG_B64}`);
    const small = `url(${PNG_URL})`;
    expect(scrubInlineBase64(small)).toBe(small);
    expect(scrubInlineBase64("hello world")).toBe("hello world");
    expect(scrubInlineBase64(undefined)).toBe(undefined);
  });

  it("toolContentText never throws and never inlines an image", () => {
    const circular = {};
    circular.self = circular;
    expect(toolContentText(circular)).toBe("");
    expect(toolContentText(null)).toBe("");
    expect(toolContentText([{ type: "image_url", image_url: { url: JPEG_URL } }, { type: "text", text: "t" }]))
      .toBe(`${MEDIA_OMITTED_TEXT.IMAGE}\nt`);
  });
});

describe("modality strip", () => {
  it("drops an input_image from a tool output for a model without vision", () => {
    const body = responsesBody();
    stripUnsupportedModalities(body, FORMATS.OPENAI_RESPONSES, { vision: false });
    const output = body.input.find((i) => i.type === "function_call_output").output;
    expect(output.some((p) => p.type === "input_image")).toBe(false);
    expect(output[0]).toEqual({ type: "input_text", text: "Output:" });
  });

  it("also drops a Chat-shaped image_url from a tool output", () => {
    const body = responsesBody([{ type: "image_url", image_url: { url: PNG_URL } }]);
    stripUnsupportedModalities(body, FORMATS.OPENAI_RESPONSES, { vision: false });
    const output = body.input.find((i) => i.type === "function_call_output").output;
    expect(output.some((p) => p.type === "image_url")).toBe(false);
  });

  it("drops an image inside a Claude tool_result", () => {
    const body = { messages: [
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "screenshot", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: [
        { type: "text", text: "Output:" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: PNG_B64 } },
      ] }] },
    ] };
    stripUnsupportedModalities(body, FORMATS.CLAUDE, { vision: false });
    const content = body.messages[1].content[0].content;
    expect(content.some((b) => b.type === "image")).toBe(false);
    expect(content[0]).toEqual({ type: "text", text: "Output:" });
  });
});

describe("local token estimates count an image as an image", () => {
  const bigShot = screenshotOutput(`data:image/jpeg;base64,${BIG_JPEG_B64}`);

  it("context meter and billing estimate after the pivot", () => {
    const chat = translateRequest(FORMATS.OPENAI_RESPONSES, FORMATS.OPENAI, "gpt-x", responsesBody(bigShot), true, null, null);
    expect(estimateInputTokens(chat)).toBeLessThan(IMAGE_TOKEN_ESTIMATE + 500);
    expect(estimateInputTokens(chat)).toBeGreaterThanOrEqual(IMAGE_TOKEN_ESTIMATE);
    const claude = translateRequest(FORMATS.OPENAI_RESPONSES, FORMATS.CLAUDE, CLAUDE_MODEL, responsesBody(bigShot), true, null, null);
    expect(estimateBillingInputTokens(claude)).toBeLessThan(IMAGE_TOKEN_ESTIMATE + 500);
  });

  it("count_tokens counts an image block flat, inside a tool_result too", () => {
    const image = { type: "image", source: { type: "base64", media_type: "image/jpeg", data: BIG_B64 } };
    const tokens = estimateAnthropicInputTokens({
      messages: [
        { role: "user", content: [image] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: [{ type: "text", text: "Output:" }, image] }] },
      ],
    });
    expect(tokens).toBeGreaterThanOrEqual(2 * IMAGE_TOKEN_ESTIMATE);
    expect(tokens).toBeLessThan(2 * IMAGE_TOKEN_ESTIMATE + 100);
  });
});

// Chat-format building blocks
const chatTurn = (ids) => ({
  role: "assistant",
  content: null,
  tool_calls: ids.map((id) => ({ id, type: "function", function: { name: "screenshot", arguments: "{}" } })),
});
const toolMsg = (id, content) => ({ role: "tool", tool_call_id: id, content });
const imagePart = (url = PNG_URL) => ({ type: "image_url", image_url: { url } });
const chatBody = (content) => ({ messages: [{ role: "user", content: "go" }, chatTurn(["call_1"]), toolMsg("call_1", content)] });
const toolResultOf = (out) => out.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).find((b) => b.type === "tool_result");
const withoutCache = (value) => JSON.parse(JSON.stringify(value, (k, v) => (k === "cache_control" ? undefined : v)));

describe("image type sniff on the Claude path", () => {
  const toClaude = (body) => translateRequest(FORMATS.OPENAI, FORMATS.CLAUDE, CLAUDE_MODEL, body, true, null, null);
  const BMP_B64 = Buffer.from([0x42, 0x4d, 0x3a, 0, 0, 0, 0, 0, 0, 0, 0x36, 0, 0, 0]).toString("base64");
  const SVG_B64 = Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>").toString("base64");

  it("a mislabelled JPEG is sent as image/jpeg", () => {
    for (const label of ["image/jpg", "image/png", "application/octet-stream"]) {
      const result = toolResultOf(toClaude(chatBody([{ type: "text", text: "Output:" }, imagePart(`data:${label};base64,${JPEG_B64}`)])));
      expect(result.content[1]).toEqual({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: JPEG_B64 } });
    }
  });

  it("BMP, SVG and garbage become the placeholder", () => {
    for (const url of [`data:image/bmp;base64,${BMP_B64}`, `data:image/svg+xml;base64,${SVG_B64}`, "data:image/png;base64,AAAAAAAAAAAA"]) {
      const result = toolResultOf(toClaude(chatBody([{ type: "text", text: "Output:" }, imagePart(url)])));
      expect(result.content).toEqual([{ type: "text", text: "Output:" }, { type: "text", text: MEDIA_OMITTED_TEXT.IMAGE }]);
    }
  });

  it("user-message images get the same check", () => {
    const out = toClaude({ messages: [{ role: "user", content: [
      { type: "text", text: "look" },
      imagePart(`data:image/jpg;base64,${JPEG_B64}`),
      imagePart(`data:image/bmp;base64,${BMP_B64}`),
    ] }] });
    expect(withoutCache(out.messages[0].content)).toEqual([
      { type: "text", text: "look" },
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: JPEG_B64 } },
      { type: "text", text: MEDIA_OMITTED_TEXT.IMAGE },
    ]);
  });
});

describe("the scrub leaves real text alone", () => {
  const cases = [
    ["an 1100-digit number", "9".repeat(1100)],
    ["0x bytecode", `0x${"6080604052".repeat(300)}`],
    ["a kubeconfig line", `    certificate-authority-data: ${"LS0tLS1CRUdJTiBDRVJUSUZJQ0FURS0tLS0t".repeat(60)}`],
    ["a CSS woff2 data URL", `@font-face { src: url(data:font/woff2;base64,${"d09GMgABAAAAA".repeat(200)}) format("woff2"); }`],
  ];
  for (const [name, text] of cases) {
    it(`${name} in a string output reaches Claude and OpenAI unchanged`, () => {
      expect(scrubInlineBase64(text)).toBe(text);
      const claude = translateRequest(FORMATS.OPENAI_RESPONSES, FORMATS.CLAUDE, CLAUDE_MODEL, responsesBody(text), true, null, null);
      expect(toolResultOf(claude).content).toBe(text);
      const chat = translateRequest(FORMATS.OPENAI_RESPONSES, FORMATS.OPENAI, "gpt-x", responsesBody(text), true, null, null);
      expect(toolMessages(chat)[0].content).toBe(text);
    });
  }

  it("600 KB of near-miss text goes through in one linear pass, unchanged", () => {
    const line = `data:image/png;base64 ${"A".repeat(1023)} data:image/png;base64,${"B".repeat(1000)} ${"C".repeat(1023)}\n`;
    const nearMiss = line.repeat(200);
    expect(nearMiss.length).toBeGreaterThan(600_000);
    expect(scrubInlineBase64(nearMiss)).toBe(nearMiss);
  });
});

describe("edge shapes", () => {
  it("Claude: empty text is dropped; nothing left means an empty string tool_result", () => {
    const fromResponses = translateRequest(FORMATS.OPENAI_RESPONSES, FORMATS.CLAUDE, CLAUDE_MODEL, responsesBody([{ type: "input_text", text: "" }]), true, null, null);
    expect(toolResultOf(fromResponses).content).toBe("");
    const fromChat = translateRequest(FORMATS.OPENAI, FORMATS.CLAUDE, CLAUDE_MODEL,
      chatBody([{ type: "text", text: "" }, { type: "text", text: "ok" }]), true, null, null);
    expect(toolResultOf(fromChat).content).toEqual([{ type: "text", text: "ok" }]);
    const allEmpty = translateRequest(FORMATS.OPENAI, FORMATS.CLAUDE, CLAUDE_MODEL, chatBody([{ type: "text", text: "" }]), true, null, null);
    expect(toolResultOf(allEmpty).content).toBe("");
  });

  it("Gemini and Antigravity answer an empty tool output with a functionResponse", () => {
    const gemini = translateRequest(FORMATS.OPENAI_RESPONSES, FORMATS.GEMINI, "gemini-x", responsesBody([]), true, null, null);
    const responses = gemini.contents.flatMap((c) => c.parts).filter((p) => p.functionResponse);
    expect(responses).toHaveLength(1);
    expect(responses[0].functionResponse.response).toEqual({ result: {} });
    const ag = translateRequest(FORMATS.OPENAI_RESPONSES, FORMATS.ANTIGRAVITY, "gemini-x", responsesBody([]), true, {}, null);
    expect(ag.request.contents.flatMap((c) => c.parts).filter((p) => p.functionResponse)).toHaveLength(1);
  });

  it("Chat → Responses: an image_url with no url becomes a placeholder, not an empty input_image", () => {
    const out = translateRequest(FORMATS.OPENAI, FORMATS.OPENAI_RESPONSES, "gpt-x",
      chatBody([{ type: "text", text: "Output:" }, { type: "image_url", image_url: { url: "" } }]), true, null, null);
    expect(out.input.find((i) => i.type === "function_call_output").output).toEqual([
      { type: "input_text", text: "Output:" },
      { type: "input_text", text: MEDIA_OMITTED_TEXT.IMAGE },
    ]);
  });

  it("a bare-string image_url reaches a Chat target and Gemini as an image", () => {
    const body = () => chatBody([{ type: "text", text: "Output:" }, { type: "image_url", image_url: PNG_URL }]);
    const chat = translateRequest(FORMATS.OPENAI, FORMATS.OPENAI, "gpt-x", body(), true, null, null);
    expect(chat.messages.at(-1)).toEqual({ role: "user", content: [{ type: "image_url", image_url: { url: PNG_URL } }] });
    const gemini = translateRequest(FORMATS.OPENAI, FORMATS.GEMINI, "gemini-x", body(), true, null, null);
    expect(gemini.contents.flatMap((c) => c.parts)).toContainEqual({ inlineData: { mime_type: "image/png", data: PNG_B64 } });
  });

  it("Gemini keeps an https screenshot as its URL, with no wildcard fileData", () => {
    const out = translateRequest(FORMATS.OPENAI_RESPONSES, FORMATS.GEMINI, "gemini-x",
      responsesBody([{ type: "input_text", text: "Output:" }, { type: "input_image", image_url: "https://example.com/shot.png" }]), true, null, null);
    const parts = out.contents.flatMap((c) => c.parts);
    expect(parts.find((p) => p.functionResponse).functionResponse.response.result).toEqual({ result: "Output:\n[Image: https://example.com/shot.png]" });
    expect(parts.some((p) => p.fileData)).toBe(false);
  });

  it("openai → openai leaves the client's body as it was", () => {
    const body = chatBody([{ type: "text", text: "Output:" }, imagePart()]);
    const before = JSON.stringify(body);
    const out = translateRequest(FORMATS.OPENAI, FORMATS.OPENAI, "gpt-x", body, true, null, null);
    expect(out.messages.at(-1).role).toBe("user");
    expect(JSON.stringify(body)).toBe(before);
  });
});

describe("moveToolImagesToUserTurn ordering", () => {
  it("each assistant turn's images follow its own tool results", () => {
    const out = moveToolImagesToUserTurn([
      { role: "user", content: "go" },
      chatTurn(["call_1"]), toolMsg("call_1", [imagePart(PNG_URL)]),
      chatTurn(["call_2"]), toolMsg("call_2", [imagePart(JPEG_URL)]),
    ]);
    expect(out.map((m) => m.role)).toEqual(["user", "assistant", "tool", "user", "assistant", "tool", "user"]);
    expect(out[3].content).toEqual([imagePart(PNG_URL)]);
    expect(out[6].content).toEqual([imagePart(JPEG_URL)]);
  });

  it("a text-only tool result in the same run stays inside the run", () => {
    const messages = [
      { role: "user", content: "go" },
      chatTurn(["call_1", "call_2"]),
      toolMsg("call_1", [{ type: "text", text: "shot" }, imagePart()]),
      toolMsg("call_2", "plain"),
    ];
    const out = moveToolImagesToUserTurn(messages);
    expect(out.map((m) => m.role)).toEqual(["user", "assistant", "tool", "tool", "user"]);
    expect(out[3]).toBe(messages[3]);
  });
});

describe("tool text is scrubbed at each consumer", () => {
  const BIG_DATA_URL = `data:image/jpeg;base64,${BIG_JPEG_B64}`;

  it("a Chat client's tool text with a data URL, to Claude and to OpenAI", () => {
    for (const content of [[{ type: "text", text: `shot: ${BIG_DATA_URL}` }], `shot: ${BIG_DATA_URL}`]) {
      const claude = translateRequest(FORMATS.OPENAI, FORMATS.CLAUDE, CLAUDE_MODEL, chatBody(content), true, null, null);
      const claudeContent = toolResultOf(claude).content;
      expect(typeof claudeContent === "string" ? claudeContent : claudeContent[0].text).toBe(`shot: ${MEDIA_OMITTED_TEXT.IMAGE}`);
      const chat = translateRequest(FORMATS.OPENAI, FORMATS.OPENAI, "gpt-x", chatBody(content), true, null, null);
      const chatContent = toolMessages(chat)[0].content;
      expect(typeof chatContent === "string" ? chatContent : chatContent[0].text).toBe(`shot: ${MEDIA_OMITTED_TEXT.IMAGE}`);
    }
  });

  it("a Claude client's tool_result with a document, to OpenAI and Antigravity", () => {
    const PDF_B64 = Buffer.from(`%PDF-1.4 ${"x".repeat(3000)}`).toString("base64");
    const body = () => ({
      model: CLAUDE_MODEL,
      max_tokens: 1024,
      messages: [
        { role: "user", content: "go" },
        { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "read_pdf", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: [
          { type: "document", source: { type: "base64", media_type: "application/pdf", data: PDF_B64 } },
        ] }] },
      ],
    });
    const chat = translateRequest(FORMATS.CLAUDE, FORMATS.OPENAI, "gpt-x", body(), true, null, null);
    expect(toolMessages(chat)[0].content).toBe(MEDIA_OMITTED_TEXT.FILE);
    expect(JSON.stringify(chat)).not.toContain(PDF_B64);
    for (const model of [CLAUDE_MODEL, "gemini-x"]) {
      const ag = translateRequest(FORMATS.CLAUDE, FORMATS.ANTIGRAVITY, model, body(), true, {}, null);
      expect(JSON.stringify(ag)).not.toContain(PDF_B64);
    }
  });
});

describe("Grok CLI", () => {
  it("an image tool output reaches Grok as text with a placeholder, not a data URL", () => {
    const out = new GrokCliExecutor().transformRequest("grok-4.5", {
      model: "grok-4.5",
      input: [
        { type: "message", role: "user", content: "go" },
        { type: "function_call", call_id: "call_1", name: "screenshot", arguments: "{}" },
        { type: "function_call_output", call_id: "call_1", output: screenshotOutput() },
      ],
    }, true, { connectionId: "tool-result-images" });
    expect(out.input.find((i) => i.type === "function_call_output").output).toBe(`Output:\n${MEDIA_OMITTED_TEXT.IMAGE}`);
    expect(JSON.stringify(out)).not.toContain(JPEG_B64);
  });
});

// Real image headers of a given pixel size, padded to `base64Length` base64 characters.
const padTo = (head, base64Length) => Buffer.concat([head, Buffer.alloc(Math.max(0, Math.floor((base64Length * 3) / 4) - head.length))]).toString("base64");
const pngOf = (width, height, base64Length = 200) => {
  const head = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]).copy(head, 0);
  head.write("IHDR", 12, "latin1");
  head.writeUInt32BE(width, 16);
  head.writeUInt32BE(height, 20);
  return padTo(head, base64Length);
};
const jpegOf = (width, height, sof = 0xc0) => {
  const app0 = Buffer.from([0xff, 0xe0, 0, 16, ...Buffer.from("JFIF\0"), 1, 1, 0, 0, 1, 0, 1, 0, 0]);
  const frame = Buffer.from([0xff, sof, 0, 17, 8, height >> 8, height & 0xff, width >> 8, width & 0xff, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, frame, Buffer.alloc(16)]).toString("base64");
};
const gifOf = (width, height) => {
  const head = Buffer.alloc(16);
  head.write("GIF89a", 0, "latin1");
  head.writeUInt16LE(width, 6);
  head.writeUInt16LE(height, 8);
  return head.toString("base64");
};
const webpOf = (chunk, width, height) => {
  const head = Buffer.alloc(40);
  head.write("RIFF", 0, "latin1");
  head.writeUInt32LE(32, 4);
  head.write("WEBP", 8, "latin1");
  head.write(chunk, 12, "latin1");
  if (chunk === "VP8X") {
    head.writeUIntLE(width - 1, 24, 3);
    head.writeUIntLE(height - 1, 27, 3);
  } else if (chunk === "VP8 ") {
    Buffer.from([0x9d, 0x01, 0x2a]).copy(head, 23);
    head.writeUInt16LE(width, 26);
    head.writeUInt16LE(height, 28);
  } else {
    head[20] = 0x2f;
    const w = width - 1;
    const h = height - 1;
    head[21] = w & 0xff;
    head[22] = ((w >> 8) & 0x3f) | ((h & 0x3) << 6);
    head[23] = (h >> 2) & 0xff;
    head[24] = (h >> 10) & 0x0f;
  }
  return head.toString("base64");
};

describe("image dimensions from the header", () => {
  it("reads PNG, JPEG (SOF0 and SOF2), GIF and WebP (VP8, VP8L, VP8X)", () => {
    expect(imageDimensions(pngOf(2880, 1800))).toEqual({ width: 2880, height: 1800 });
    expect(imageDimensions(jpegOf(1440, 900))).toEqual({ width: 1440, height: 900 });
    expect(imageDimensions(jpegOf(3024, 1964, 0xc2))).toEqual({ width: 3024, height: 1964 });
    expect(imageDimensions(gifOf(320, 200))).toEqual({ width: 320, height: 200 });
    expect(imageDimensions(webpOf("VP8 ", 1280, 800))).toEqual({ width: 1280, height: 800 });
    expect(imageDimensions(webpOf("VP8L", 2560, 1600))).toEqual({ width: 2560, height: 1600 });
    expect(imageDimensions(webpOf("VP8X", 5120, 2880))).toEqual({ width: 5120, height: 2880 });
  });

  it("returns null when it can't tell", () => {
    expect(imageDimensions("AAAAAAAAAAAA")).toBeNull();
    expect(imageDimensions(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16]).toString("base64"))).toBeNull();
    expect(imageDimensions("")).toBeNull();
  });
});

describe("image window for long sessions", () => {
  const W = IMAGE_WINDOW.CLAUDE;
  const plan = (entries, limits = W) => planImageWindow(entries, limits);
  const shot = (bytes, large = false) => ({ tool: true, bytes, large: () => large });
  const userShot = (bytes, large = false) => ({ tool: false, bytes, large: () => large });
  const windowBytes = (entries, dropped) => entries.reduce((sum, e, i) => sum + (dropped.has(i) ? 0 : e.bytes), 0);
  // Turns (1-based) at which the dropped set changed, adding one entry per turn.
  const trimTurns = (make, turns, limits = W) => {
    const entries = [];
    let previous = new Set();
    const changes = [];
    for (let turn = 1; turn <= turns; turn++) {
      entries.push(make(turn));
      const dropped = plan(entries, limits);
      for (const i of previous) expect(dropped.has(i)).toBe(true); // only ever grows
      expect(dropped.has(entries.length - 1)).toBe(false); // the newest is kept
      if (dropped.size !== previous.size) changes.push(turn);
      previous = dropped;
    }
    return { changes, dropped: previous, entries };
  };

  it("the real limits sit under each upstream's limits", () => {
    expect(W.images.hard).toBeLessThanOrEqual(100);
    expect(W.base64Bytes.hard).toBeLessThan(32 * 1000 * 1000);
    expect(W.images.trigger).toBe(W.images.hard * 0.8);
    expect(W.images.target).toBe(W.images.hard * 0.5);
    expect(W.base64Bytes.trigger).toBeCloseTo(W.base64Bytes.hard * 0.8, -6);
    expect(W.base64Bytes.target).toBeCloseTo(W.base64Bytes.hard * 0.5, -6);
    expect(W.hiRes).toEqual({ maxSide: 2000, trigger: 20, target: 16 });
    expect(W.countUrlImages).toBe(true);
    expect(IMAGE_WINDOW.KIRO.hiRes).toBeUndefined();
    expect(IMAGE_WINDOW.KIRO.countUrlImages).toBe(false);
    expect(IMAGE_WINDOW.GEMINI.images).toBeUndefined();
    expect(IMAGE_WINDOW.GEMINI.hiRes).toBeUndefined();
    expect(IMAGE_WINDOW.GEMINI.base64Bytes.hard).toBeLessThan(20 * 1000 * 1000);
  });

  it("user images survive while tool images remain", () => {
    const entries = [...Array.from({ length: 50 }, () => userShot(100)), ...Array.from({ length: 40 }, () => shot(100))];
    const dropped = plan(entries);
    expect(dropped.size).toBeGreaterThan(0);
    for (const i of dropped) expect(entries[i].tool).toBe(true);
  });

  it("user-only images over the trigger: dropped in one chunk down to the target", () => {
    const { changes, dropped, entries } = trimTurns(() => userShot(100), 130);
    expect(changes).toEqual([81, 112]);
    expect(entries.length - dropped.size).toBe(W.images.target + 18);
  });

  it("1 MB user screenshots: chunky trims, not one break per turn", () => {
    const { changes } = trimTurns(() => userShot(1_000_000), 90);
    expect(changes).toEqual([25, 35, 45, 55, 65, 75, 85]); // over 24M, back to 15M each time
  });

  // User images alone between the trigger and the hard limit, then a stream
  // of tool screenshots: the user images are trimmed once, instead of every
  // new screenshot evicting the one before it.
  it("Claude: 4 × 6.5M user images, then 100 screenshots", () => {
    const { changes } = trimTurns((turn) => (turn <= 4 ? userShot(6_500_000) : shot(1000)), 104);
    expect(changes).toEqual([4, 83]);
  });

  it("Gemini: 3 × 5M user images, then 100 screenshots", () => {
    const { changes } = trimTurns((turn) => (turn <= 3 ? userShot(5_000_000) : shot(1000)), 103, IMAGE_WINDOW.GEMINI);
    expect(changes).toEqual([3]);
  });

  it("Claude: 85 small user images, then 100 screenshots", () => {
    const { changes } = trimTurns((turn) => (turn <= 85 ? userShot(100) : shot(100)), 185);
    expect(changes).toEqual([81, 112, 138, 164]);
  });

  it("tool images go before user images in the same trim", () => {
    const entries = [...Array.from({ length: 10 }, () => shot(100)), ...Array.from({ length: 95 }, () => userShot(100))];
    expect([...plan(entries.slice(0, 81))].sort((a, b) => a - b)).toEqual([...Array(10).keys()]);
    const dropped = plan(entries);
    expect([...dropped].sort((a, b) => a - b)).toEqual([...Array(41).keys()]);
    expect(entries.length - dropped.size).toBe(64);
  });

  it("hi-res with a large newest image keeps the newest 20, not old small ones", () => {
    const entries = [...Array.from({ length: 15 }, () => shot(1000, false)), ...Array.from({ length: 40 }, () => shot(1000, true))];
    const dropped = plan(entries);
    const kept = entries.map((_, i) => i).filter((i) => !dropped.has(i));
    expect(kept).toEqual([...Array(20).keys()].map((i) => i + 35));
  });

  it("hi-res with a small newest image drops just the large ones, tool images first", () => {
    const one = [...Array.from({ length: 5 }, () => shot(1000)), shot(1000, true), ...Array.from({ length: 15 }, () => shot(1000))];
    expect([...plan(one)]).toEqual([5]);
    const users = Array.from({ length: 3 }, () => userShot(1000, true));
    const tools = Array.from({ length: 3 }, () => shot(1000, true));
    const mixed = [...users, ...tools, ...Array.from({ length: 15 }, () => shot(1000))];
    expect([...plan(mixed)].sort((a, b) => a - b)).toEqual([0, 1, 3, 4, 5]);
  });

  it("Gemini: the limits are pinned, and 1M screenshots trim at the exact turns", () => {
    const G = IMAGE_WINDOW.GEMINI.base64Bytes;
    expect(G.trigger).toBeCloseTo(G.hard * 0.8, -6);
    expect(G.target).toBe(G.hard * 0.5);
    const { changes } = trimTurns(() => shot(1_000_000), 60, IMAGE_WINDOW.GEMINI);
    expect(changes).toEqual([15, 21, 27, 33, 39, 45, 51, 57]);
  });

  it("130 hi-res user screenshots: the dropped set changes only at trims", () => {
    const { changes, dropped, entries } = trimTurns(() => userShot(1000, true), 130);
    expect(entries.length - dropped.size).toBeLessThanOrEqual(W.hiRes.trigger);
    for (let i = 1; i < changes.length; i++) expect(changes[i] - changes[i - 1]).toBe(W.hiRes.trigger + 1 - W.hiRes.target);
  });

  it("one old hi-res user image clears the rule once, then the window grows back toward 80", () => {
    const { changes, dropped, entries } = trimTurns((turn) => (turn === 1 ? userShot(0, true) : shot(1000)), 80);
    expect(changes).toEqual([21]);
    expect([...dropped]).toEqual([0]);
    expect(entries.length - dropped.size).toBe(79);
  });

  it("60 turns of 1M screenshots: the oldest go in chunks, constant between trims", () => {
    const entries = [];
    const starts = [];
    for (let turn = 1; turn <= 60; turn++) {
      entries.push(shot(1_000_000));
      const dropped = plan(entries);
      const start = dropped.size;
      // always the oldest ones
      expect([...dropped].sort((a, b) => a - b)).toEqual([...Array(start).keys()]);
      expect(windowBytes(entries, dropped)).toBeLessThanOrEqual(W.base64Bytes.trigger);
      starts.push(start);
    }
    const changes = starts.flatMap((s, i) => (i > 0 && s !== starts[i - 1] ? [i + 1] : []));
    expect(changes).toEqual([25, 35, 45, 55]); // trigger at 24 MB, back to 15 MB each time
    for (let i = 1; i < starts.length; i++) expect(starts[i]).toBeGreaterThanOrEqual(starts[i - 1]);
  });

  it("mixed sizes: what is dropped only grows, and the window stays under the trigger", () => {
    const sizes = [200_000, 2_000_000, 600_000, 4_000_000, 50_000];
    const entries = [];
    let previous = new Set();
    let trims = 0;
    for (let turn = 0; turn < 80; turn++) {
      entries.push(shot(sizes[turn % sizes.length]));
      const dropped = plan(entries);
      for (const i of previous) expect(dropped.has(i)).toBe(true);
      if (dropped.size !== previous.size) trims++;
      expect(windowBytes(entries, dropped)).toBeLessThanOrEqual(W.base64Bytes.trigger);
      previous = dropped;
    }
    expect(trims).toBeLessThan(12);
  });

  it("95 user images and 10 tool images stay within 100", () => {
    const image = { type: "image", source: { type: "base64", media_type: "image/png", data: PNG_B64 } };
    const messages = [
      { role: "user", content: Array.from({ length: 95 }, () => image) },
      { role: "user", content: Array.from({ length: 10 }, (_, i) => ({ type: "tool_result", tool_use_id: `t${i}`, content: [image] })) },
    ];
    const out = capClaudeImages(messages);
    const images = JSON.stringify(out).split('"type":"image"').length - 1;
    expect(images).toBe(74); // 31 user images went at the 81st, before any tool image existed
    expect(out[1].content.at(-1).content[0].type).toBe("image"); // the newest is kept
    expect(messages[1].content[0].content[0].type).toBe("image"); // input untouched
  });

  it("eight 4M screenshots stay under the hard size", () => {
    const entries = Array.from({ length: 8 }, () => shot(4_000_000));
    const dropped = plan(entries);
    expect(windowBytes(entries, dropped)).toBeLessThanOrEqual(W.base64Bytes.hard);
    expect(dropped.has(7)).toBe(false);
  });

  it("hi-res: over 20 images with one over 2000 px trims to 16; all small is left alone", () => {
    const small = Array.from({ length: 30 }, () => shot(1000, false));
    expect(plan(small).size).toBe(0);
    const mixed = [...Array.from({ length: 20 }, () => shot(1000, false)), shot(1000, true)];
    const dropped = plan(mixed);
    expect(mixed.length - dropped.size).toBe(16);
    expect(dropped.has(20)).toBe(false);
  });

  const session = (n, url) => {
    const input = [{ type: "message", role: "user", content: [{ type: "input_text", text: "use the computer" }] }];
    for (let i = 1; i <= n; i++) {
      input.push({ type: "function_call", call_id: `call_${i}`, name: "screenshot", arguments: "{}" });
      input.push({ type: "function_call_output", call_id: `call_${i}`, output: screenshotOutput(url) });
    }
    return { model: CLAUDE_MODEL, input, tools: responsesBody().tools };
  };
  const toClaude = (body) => translateRequest(FORMATS.OPENAI_RESPONSES, FORMATS.CLAUDE, CLAUDE_MODEL, body, true, null, null);
  const shots = (out) => out.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : []))
    .filter((b) => b.type === "tool_result").map((b) => b.content[1]);

  it("Claude target: 25 retina screenshots end with at most 20 images", () => {
    const blocks = shots(toClaude(session(25, `data:image/png;base64,${pngOf(2880, 1800)}`)));
    expect(blocks.filter((b) => b.type === "image").length).toBeLessThanOrEqual(20);
    expect(blocks[0]).toEqual({ type: "text", text: MEDIA_OMITTED_TEXT.EARLIER_IMAGE });
    expect(blocks.at(-1).type).toBe("image");
  });

  it("Claude target: 100 small screenshots, the next turn keeps the same prefix", () => {
    const now = toClaude(session(100, PNG_URL));
    const next = toClaude(session(101, PNG_URL));
    const images = shots(now).filter((b) => b.type === "image").length;
    expect(images).toBeLessThanOrEqual(W.images.trigger);
    expect(shots(next).filter((b) => b.type === "text").length).toBe(100 - images);
    // Everything up to the 99th result: the 100th assistant turn holds the cache breakpoint.
    expect(withoutCache(next.messages.slice(0, 199))).toEqual(withoutCache(now.messages.slice(0, 199)));
  });

  const RETINA_URL = `data:image/png;base64,${pngOf(2880, 1800)}`;
  const kiroImages = (out) => JSON.stringify(out).split('"bytes":').length - 1;
  const withUrlUser = (body) => ({
    ...body,
    input: [{ type: "message", role: "user", content: [{ type: "input_image", image_url: "https://example.com/ref.png" }] }, ...body.input],
  });

  it("Claude target: more than 20 images of unreadable size count as hi-res", () => {
    const noFrame = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16]), Buffer.alloc(40)]).toString("base64");
    expect(imageDimensions(noFrame)).toBeNull();
    const blocks = shots(toClaude(session(25, `data:image/jpeg;base64,${noFrame}`)));
    expect(blocks.filter((b) => b.type === "image").length).toBeLessThanOrEqual(20);
  });

  it("Claude target: an old URL user image clears the hi-res rule once, and the screenshots grow back", () => {
    const out = toClaude(withUrlUser(session(60, PNG_URL)));
    expect(withoutCache(out.messages[0].content)).toContainEqual({ type: "text", text: MEDIA_OMITTED_TEXT.EARLIER_IMAGE });
    expect(shots(out).every((b) => b.type === "image")).toBe(true); // all 60 kept
  });

  it("Kiro: no hi-res rule, so 25 Retina screenshots all stay", () => {
    for (const url of [PNG_URL, RETINA_URL]) {
      const kiro = translateRequest(FORMATS.OPENAI_RESPONSES, FORMATS.KIRO, CLAUDE_MODEL, withUrlUser(session(25, url)), true, {}, null);
      expect(kiroImages(kiro)).toBe(25);
      expect(JSON.stringify(kiro)).not.toContain(MEDIA_OMITTED_TEXT.EARLIER_IMAGE);
    }
  });

  it("Kiro: URL images don't count toward the 80 trigger", () => {
    const body = session(79, PNG_URL);
    body.input.unshift({ type: "message", role: "user", content: Array.from({ length: 5 }, (_, i) => ({ type: "input_image", image_url: `https://example.com/ref${i}.png` })) });
    const kiro = translateRequest(FORMATS.OPENAI_RESPONSES, FORMATS.KIRO, CLAUDE_MODEL, body, true, {}, null);
    expect(kiroImages(kiro)).toBe(79);
    expect(JSON.stringify(kiro)).not.toContain(MEDIA_OMITTED_TEXT.EARLIER_IMAGE);
  });

  const claudeSession = (n, data) => {
    const image = { type: "image", source: { type: "base64", media_type: "image/png", data } };
    const messages = [{ role: "user", content: "go" }];
    for (let i = 1; i <= n; i++) {
      messages.push({ role: "assistant", content: [{ type: "tool_use", id: `toolu_${i}`, name: "screenshot", input: {} }] });
      messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: `toolu_${i}`, content: [image] }] });
    }
    const tools = [{ name: "screenshot", description: "Take a screenshot", input_schema: { type: "object", properties: {} } }];
    return { model: CLAUDE_MODEL, max_tokens: 1024, tools, messages };
  };

  it("Kiro, both routes: 85 screenshots keep exactly 54", () => {
    const kiro = translateRequest(FORMATS.OPENAI_RESPONSES, FORMATS.KIRO, CLAUDE_MODEL, session(85, PNG_URL), true, {}, null);
    expect(kiroImages(kiro)).toBe(54);
    expect(JSON.stringify(kiro)).toContain(MEDIA_OMITTED_TEXT.EARLIER_IMAGE);

    const body = claudeSession(85, PNG_B64);
    const image = body.messages[2].content[0].content[0];
    const direct = translateRequest(FORMATS.CLAUDE, FORMATS.KIRO, CLAUDE_MODEL, body, true, {}, null);
    expect(kiroImages(direct)).toBe(54);
    expect(JSON.stringify(direct)).toContain(MEDIA_OMITTED_TEXT.EARLIER_IMAGE);
    expect(body.messages[2].content[0].content[0]).toBe(image); // the client's body is left alone
  });

  // A distinct small PNG per index, so every image can be followed through the output.
  const uniquePng = (i, base64Length = 200) => {
    const head = Buffer.from(pngOf(100, 100, 48), "base64");
    head.writeUInt32BE(i, 29);
    return padTo(head, base64Length);
  };
  const sentKiroImages = (out) => new Set((JSON.stringify(out).match(/"bytes":"[^"]+"/g) || []).map((m) => m.slice(9, -1)));

  for (const sharedTurn of [false, true]) {
    it(`Kiro replay over 200 turns, user image ${sharedTurn ? "in the tool result's turn" : "in its own turn"}: nothing reappears`, () => {
      clearKiroSessionReplayStore();
      const credentials = { rawHeaders: { "x-session-id": `tool-result-images-flicker-${sharedTurn}` }, connectionId: "kiro-flicker" };
      const tools = [{ type: "function", function: { name: "screenshot", parameters: { type: "object", properties: {} } } }];
      const first = [0, 1, 2].map((i) => uniquePng(10_000 + i));
      const users = [];
      const messages = [{ role: "user", content: [{ type: "text", text: "start" }, ...first.map((b) => imagePart(`data:image/png;base64,${b}`))] }];
      let previous = new Set();
      let breaks = 0;
      for (let k = 1; k <= 200; k++) {
        messages.push(chatTurn([`call_${k}`]));
        messages.push(toolMsg(`call_${k}`, [{ type: "text", text: `shot ${k}` }, imagePart(`data:image/png;base64,${uniquePng(k)}`)]));
        if (k % 2 === 0) {
          const user = uniquePng(20_000 + k);
          users.push(user);
          if (!sharedTurn) messages.push({ role: "assistant", content: "ok" });
          messages.push({ role: "user", content: [imagePart(`data:image/png;base64,${user}`)] });
        }
        const out = translateRequest(FORMATS.OPENAI, FORMATS.KIRO, CLAUDE_MODEL, { tools, messages }, true, credentials, null);
        const sent = sentKiroImages(out);
        // the newest image of the turn is always sent
        expect(sent.has(k % 2 === 0 ? users.at(-1) : uniquePng(k))).toBe(true);
        const all = [...first, ...users, ...Array.from({ length: k }, (_, i) => uniquePng(i + 1))];
        const dropped = new Set(all.filter((b) => !sent.has(b)));
        for (const b of previous) expect(dropped.has(b)).toBe(true); // nothing reappears
        if (dropped.size !== previous.size) breaks++;
        previous = dropped;
        if (k === 100) {
          // user images, next to tool results or not, outlast the tool screenshots
          for (const b of [...first, ...users]) expect(sent.has(b)).toBe(true);
        }
      }
      // 15 in 200 turns: chunks shrink as user images, kept first, fill the window
      expect(breaks).toBeLessThanOrEqual(16);
      clearKiroSessionReplayStore();
    }, 60_000);
  }

  it("Kiro never sends an empty or null images list", () => {
    const kiro = translateRequest(FORMATS.OPENAI_RESPONSES, FORMATS.KIRO, CLAUDE_MODEL, session(85, PNG_URL), true, {}, null);
    const state = kiro.conversationState;
    const inputs = [...state.history, state.currentMessage].map((t) => t.userInputMessage).filter(Boolean);
    let emptied = 0;
    for (const input of inputs) {
      if ("images" in input) {
        expect(input.images.length).toBeGreaterThan(0);
        expect(input.images.includes(null)).toBe(false);
        expect(JSON.stringify(input.images)).not.toContain("_fromToolResult");
      } else if (input.content.includes(MEDIA_OMITTED_TEXT.EARLIER_IMAGE)) {
        emptied++;
      }
    }
    expect(emptied).toBeGreaterThan(0);
  });

  it("Kiro session replay: the stored first turn's images count toward the window", () => {
    clearKiroSessionReplayStore();
    const credentials = { rawHeaders: { "x-session-id": "tool-result-images-replay" }, connectionId: "kiro-images" };
    const tools = [{ type: "function", function: { name: "screenshot", parameters: { type: "object", properties: {} } } }];
    // Turn 1: a first message with 40 images, which replay stores and puts back.
    translateRequest(FORMATS.OPENAI, FORMATS.KIRO, CLAUDE_MODEL, {
      tools,
      messages: [{ role: "user", content: [{ type: "text", text: "start" }, ...Array.from({ length: 40 }, () => imagePart(RETINA_URL))] }],
    }, true, credentials, null);
    // Later turn: the client's copy of that message has no images, then 45
    // Retina screenshots (Kiro has no hi-res rule, so only the count binds).
    const messages = [{ role: "user", content: "start" }];
    for (let i = 1; i <= 45; i++) {
      messages.push(chatTurn([`call_${i}`]));
      messages.push(toolMsg(`call_${i}`, [{ type: "text", text: `shot ${i}` }, imagePart(RETINA_URL)]));
    }
    const out = translateRequest(FORMATS.OPENAI, FORMATS.KIRO, CLAUDE_MODEL, { tools, messages }, true, credentials, null);
    const state = out.conversationState;
    expect(state.history[0].userInputMessage.images).toHaveLength(40); // user images stay
    expect(kiroImages(out)).toBe(54); // 85 over the 80 trigger: 31 oldest screenshots dropped
    expect(state.currentMessage.userInputMessage.images).toHaveLength(1); // the newest is kept
    expect(JSON.stringify(state)).toContain(MEDIA_OMITTED_TEXT.EARLIER_IMAGE);
    clearKiroSessionReplayStore();
  });

  it("direct claude → Kiro: URL user images don't count toward the 80 trigger", () => {
    const body = claudeSession(79, PNG_B64);
    body.messages[0] = { role: "user", content: [{ type: "text", text: "go" }, ...Array.from({ length: 5 }, (_, i) => ({ type: "image", source: { type: "url", url: `https://example.com/ref${i}.png` } }))] };
    const direct = translateRequest(FORMATS.CLAUDE, FORMATS.KIRO, CLAUDE_MODEL, body, true, {}, null);
    expect(kiroImages(direct)).toBe(79);
    expect(JSON.stringify(direct)).not.toContain(MEDIA_OMITTED_TEXT.EARLIER_IMAGE);
    // The Claude adapter with Kiro's limits leaves them uncounted too.
    expect(capClaudeImages(body.messages, IMAGE_WINDOW.KIRO)).toBe(body.messages);
  });

  it("user images survive while screenshots trigger the trim: Claude, Kiro and Gemini routes", () => {
    const withUserImages = (count, url) => {
      const body = session(80, PNG_URL);
      body.input.unshift({ type: "message", role: "user", content: Array.from({ length: count }, (_, i) => ({ type: "input_image", image_url: url(i) })) });
      return body;
    };
    const userUrl = (i) => `data:image/png;base64,${uniquePng(30_000 + i)}`;
    const claude = translateRequest(FORMATS.OPENAI_RESPONSES, FORMATS.CLAUDE, CLAUDE_MODEL, withUserImages(10, userUrl), true, null, null);
    expect(claude.messages[0].content.filter((b) => b.type === "image")).toHaveLength(10);
    expect(shots(claude).some((b) => b.type === "text")).toBe(true);
    const kiro = translateRequest(FORMATS.OPENAI_RESPONSES, FORMATS.KIRO, CLAUDE_MODEL, withUserImages(10, userUrl), true, {}, null);
    const sent = sentKiroImages(kiro);
    for (let i = 0; i < 10; i++) expect(sent.has(uniquePng(30_000 + i))).toBe(true);
    expect(JSON.stringify(kiro)).toContain(MEDIA_OMITTED_TEXT.EARLIER_IMAGE);
    // Gemini: 2 user images and 3 screenshots of 4M each, over 14.4M
    const big = (i) => uniquePng(40_000 + i, 4_000_000);
    const gemini = { model: "gemini-x", input: [
      { type: "message", role: "user", content: [0, 1].map((i) => ({ type: "input_image", image_url: `data:image/png;base64,${big(i)}` })) },
      ...session(3, "x").input.slice(1).map((item) => (item.type === "function_call_output"
        ? { ...item, output: screenshotOutput(`data:image/png;base64,${big(Number(item.call_id.slice(5)) + 10)}`) }
        : item)),
    ], tools: responsesBody().tools };
    const out = translateRequest(FORMATS.OPENAI_RESPONSES, FORMATS.GEMINI, "gemini-x", gemini, true, null, null);
    const inline = out.contents.flatMap((c) => c.parts).filter((p) => p.inlineData).map((p) => p.inlineData.data);
    expect(inline).toContain(big(0));
    expect(inline).toContain(big(1));
    expect(inline.length).toBeLessThan(5);
  });

  it("direct claude → Kiro: 25 Retina screenshots all stay (Kiro has no hi-res rule)", () => {
    const direct = translateRequest(FORMATS.CLAUDE, FORMATS.KIRO, CLAUDE_MODEL, claudeSession(25, pngOf(2880, 1800)), true, {}, null);
    expect(kiroImages(direct)).toBe(25);
    expect(JSON.stringify(direct)).not.toContain(MEDIA_OMITTED_TEXT.EARLIER_IMAGE);
  });

  it("Gemini: no count or hi-res rule, so 25 Retina screenshots all stay", () => {
    const gemini = translateRequest(FORMATS.OPENAI_RESPONSES, FORMATS.GEMINI, "gemini-x", session(25, RETINA_URL), true, null, null);
    expect(gemini.contents.flatMap((c) => c.parts).filter((p) => p.inlineData)).toHaveLength(25);
  });

  // A few big strings, shared, to keep memory low: 5 × 5M base64 = 25M, over the 24M trigger.
  const BIG_PNG = pngOf(100, 100, 5_000_000);
  it("Kiro: screenshots over the size trigger are trimmed back to the target", () => {
    const kiro = translateRequest(FORMATS.OPENAI_RESPONSES, FORMATS.KIRO, CLAUDE_MODEL, session(5, `data:image/png;base64,${BIG_PNG}`), true, {}, null);
    expect(kiroImages(kiro)).toBe(3); // 25M over 24M, back to 15M
  });

  it("the adapters count real base64 sizes (Claude and Chat)", () => {
    const image = { type: "image", source: { type: "base64", media_type: "image/png", data: BIG_PNG } };
    const claude = capClaudeImages(Array.from({ length: 5 }, (_, i) => ({ role: "user", content: [{ type: "tool_result", tool_use_id: `t${i}`, content: [image] }] })));
    expect(claude.filter((m) => m.content[0].content[0].type === "image")).toHaveLength(3); // back to ≤15M
    const chat = capChatImages(Array.from({ length: 5 }, (_, i) => toolMsg(`call_${i}`, [imagePart(`data:image/png;base64,${BIG_PNG}`)])));
    expect(chat.filter((m) => m.content[0].type === "image_url")).toHaveLength(3);
  });

  // Gemini's budget is 14.4M to trigger, 9M to target: the third 5M image
  // trims back to one, the fourth makes two.
  const geminiTargets = [
    [FORMATS.GEMINI, (out) => out.contents],
    [FORMATS.GEMINI_CLI, (out) => out.request.contents],
    [FORMATS.VERTEX, (out) => out.contents],
    [FORMATS.ANTIGRAVITY, (out) => out.request.contents],
  ];
  for (const [target, contentsOf] of geminiTargets) {
    it(`${target}: the Gemini byte budget applies`, () => {
      const out = translateRequest(FORMATS.OPENAI_RESPONSES, target, "gemini-x", session(4, `data:image/png;base64,${BIG_PNG}`), true, {}, null);
      const parts = contentsOf(out).flatMap((c) => c.parts);
      expect(parts.filter((p) => p.inlineData)).toHaveLength(2);
      expect(parts.filter((p) => p.functionResponse).map((p) => JSON.stringify(p.functionResponse.response)).join()).toContain(MEDIA_OMITTED_TEXT.EARLIER_IMAGE);
    });
  }

  it("the Chat window leaves its input alone", () => {
    const chat = [{ role: "user", content: "go" }, ...Array.from({ length: 25 }, (_, i) => toolMsg(`call_${i}`, [imagePart(RETINA_URL)]))];
    const before = JSON.stringify(chat);
    const capped = capChatImages(chat);
    expect(capped).not.toBe(chat);
    expect(JSON.stringify(chat)).toBe(before);
  });
});

describe("JPEG frame header past the first bytes", () => {
  it("is found ~60 KB in, after an ICC profile and a Huffman table", () => {
    const segment = (marker, length) => {
      const seg = Buffer.alloc(2 + length);
      seg[0] = 0xff;
      seg[1] = marker;
      seg.writeUInt16BE(length, 2);
      return seg;
    };
    const dht = segment(0xc4, 32);
    dht[4] = 0x00; // looks nothing like a frame size, so reading it as SOF gives a wrong answer
    const jpeg = Buffer.concat([
      Buffer.from([0xff, 0xd8]),
      segment(0xe2, 60_000), // APP2 ICC profile: the frame header lands ~60 KB in
      dht,
      Buffer.from([0xff, 0xc0, 0, 17, 8, 1800 >> 8, 1800 & 0xff, 2880 >> 8, 2880 & 0xff, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]),
      Buffer.alloc(64),
    ]);
    expect(imageDimensions(jpeg.toString("base64"))).toEqual({ width: 2880, height: 1800 });
  });
});

describe("scrub threshold, image typing and the text-only consumers", () => {
  it("the scrub threshold: a 60K image data URL stays, a 70K one goes", () => {
    const at = (n) => `x data:image/png;base64,${"A".repeat(n)} y`;
    expect(scrubInlineBase64(at(60_000))).toBe(at(60_000));
    expect(scrubInlineBase64(at(70_000))).toBe(`x ${MEDIA_OMITTED_TEXT.IMAGE} y`);
  });

  it("a long chain of data: headers with parameters goes through in one pass, unchanged", () => {
    const chain = "data:image/png;x=".repeat(40_000);
    expect(chain.length).toBeGreaterThan(600_000);
    expect(scrubInlineBase64(chain)).toBe(chain);
  });

  it("Claude tool_result text and Chat string tool results are scrubbed on every route", () => {
    const shotUrl = `data:image/png;base64,${"A".repeat(70_000)}`;
    for (const content of [[{ type: "text", text: `saved ${shotUrl}` }], `saved ${shotUrl}`]) {
      const claudeBody = {
        model: CLAUDE_MODEL,
        max_tokens: 1024,
        tools: [{ name: "screenshot", description: "Take a screenshot", input_schema: { type: "object", properties: {} } }],
        messages: [
          { role: "user", content: "go" },
          { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "screenshot", input: {} }] },
          { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content }] },
        ],
      };
      for (const target of [FORMATS.OPENAI, FORMATS.OPENAI_RESPONSES, FORMATS.CURSOR, FORMATS.KIRO]) {
        const out = translateRequest(FORMATS.CLAUDE, target, CLAUDE_MODEL, structuredClone(claudeBody), true, {}, null);
        expect(JSON.stringify(out), target).not.toContain(shotUrl);
        expect(JSON.stringify(out), target).toContain(`saved ${MEDIA_OMITTED_TEXT.IMAGE}`);
      }
    }
    const gemini = translateRequest(FORMATS.OPENAI, FORMATS.GEMINI, "gemini-x", chatBody(`saved ${shotUrl}`), true, null, null);
    expect(JSON.stringify(gemini)).not.toContain(shotUrl);
  });

  it("a Chat tool message with a data URL in its text next to an image: no base64 in any text, on every target", () => {
    const payload = "A".repeat(70_000);
    const content = [{ type: "text", text: `log: data:image/png;base64,${payload}` }, imagePart(PNG_URL)];
    for (const [target, model, creds] of [
      [FORMATS.OPENAI, "gpt-x", null],
      [FORMATS.GEMINI, "gemini-x", null],
      [FORMATS.KIRO, CLAUDE_MODEL, {}],
      [FORMATS.OLLAMA, "ollama-x", null],
    ]) {
      const out = translateRequest(FORMATS.OPENAI, target, model, chatBody(structuredClone(content)), true, creds, null);
      const json = JSON.stringify(out);
      expect(json, target).not.toContain(payload);
      expect(json, target).toContain(`log: ${MEDIA_OMITTED_TEXT.IMAGE}`);
      expect(json, target).toContain(PNG_B64); // the real image still goes as an image
    }
  });

  it("notes are numbered per image, from the offset", () => {
    const { text, images } = splitToolContent([imagePart(PNG_URL), { type: "text", text: "between" }, imagePart(JPEG_URL), imagePart(PNG_URL)], { offset: 2 });
    expect(text).toBe("[image 3 attached below]\nbetween\n[image 4 attached below]\n[image 5 attached below]");
    expect(images).toHaveLength(3);
  });

  it("the scrub catches RFC 2397 parameters and any case", () => {
    const payload = "A".repeat(70_000);
    expect(scrubInlineBase64(`x data:image/png;name=a.png;charset=utf-8;base64,${payload} y`)).toBe(`x ${MEDIA_OMITTED_TEXT.IMAGE} y`);
    expect(scrubInlineBase64(`x DATA:IMAGE/PNG;BASE64,${payload} y`)).toBe(`x ${MEDIA_OMITTED_TEXT.IMAGE} y`);
    expect(scrubInlineBase64(`x Data:Application/PDF;Base64,${payload} y`)).toBe(`x ${MEDIA_OMITTED_TEXT.FILE} y`);
    const font = `x data:font/woff2;name=f.woff2;base64,${payload} y`;
    expect(scrubInlineBase64(font)).toBe(font);
  });

  it("a Claude-shaped base64 image in Chat content is typed by its bytes", () => {
    const BMP_B64 = Buffer.from([0x42, 0x4d, 0x3a, 0, 0, 0, 0, 0, 0, 0, 0x36, 0, 0, 0]).toString("base64");
    const out = translateRequest(FORMATS.OPENAI, FORMATS.CLAUDE, CLAUDE_MODEL, { messages: [{ role: "user", content: [
      { type: "text", text: "look" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: JPEG_B64 } },
      { type: "image", source: { type: "base64", media_type: "image/png", data: BMP_B64 } },
    ] }] }, true, null, null);
    expect(withoutCache(out.messages[0].content)).toEqual([
      { type: "text", text: "look" },
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: JPEG_B64 } },
      { type: "text", text: MEDIA_OMITTED_TEXT.IMAGE },
    ]);
  });

  it("GIF and WebP are accepted on the Claude path", () => {
    for (const [mime, data] of [["image/gif", gifOf(10, 10)], ["image/webp", webpOf("VP8X", 10, 10)]]) {
      const out = translateRequest(FORMATS.OPENAI, FORMATS.CLAUDE, CLAUDE_MODEL,
        chatBody([imagePart(`data:application/octet-stream;base64,${data}`)]), true, null, null);
      expect(toolResultOf(out).content).toEqual([{ type: "image", source: { type: "base64", media_type: mime, data } }]);
    }
  });

  it("toolContentText scrubs a string (the Devin and Grok paths)", () => {
    expect(toolContentText(`x data:image/png;base64,${BIG_B64} y`)).toBe(`x ${MEDIA_OMITTED_TEXT.IMAGE} y`);
  });

  it("Grok: string outputs and text-only arrays with a screenshot data URL are scrubbed", () => {
    const shotUrl = `data:image/png;base64,${BIG_B64}`;
    const out = new GrokCliExecutor().transformRequest("grok-4.5", {
      model: "grok-4.5",
      input: [
        { type: "message", role: "user", content: "go" },
        { type: "function_call", call_id: "call_1", name: "screenshot", arguments: "{}" },
        { type: "function_call_output", call_id: "call_1", output: `saved ${shotUrl}` },
        { type: "function_call", call_id: "call_2", name: "screenshot", arguments: "{}" },
        { type: "function_call_output", call_id: "call_2", output: [{ type: "input_text", text: shotUrl }] },
      ],
    }, true, { connectionId: "tool-result-images-2" });
    const outputs = out.input.filter((i) => i.type === "function_call_output").map((i) => i.output);
    expect(outputs[0]).toBe(`saved ${MEDIA_OMITTED_TEXT.IMAGE}`);
    expect(outputs[1]).toContain(MEDIA_OMITTED_TEXT.IMAGE);
    expect(JSON.stringify(out)).not.toContain(BIG_B64);
  });

  it("the direct claude → Kiro route: documents and URL images never put base64 in the tool text", () => {
    const PDF_B64 = Buffer.from(`%PDF-1.4 ${"x".repeat(3000)}`).toString("base64");
    const out = translateRequest(FORMATS.CLAUDE, FORMATS.KIRO, CLAUDE_MODEL, {
      model: CLAUDE_MODEL,
      max_tokens: 1024,
      tools: [{ name: "read", description: "Read", input_schema: { type: "object", properties: {} } }],
      messages: [
        { role: "user", content: "go" },
        { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "read", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: [
          { type: "document", source: { type: "base64", media_type: "application/pdf", data: PDF_B64 } },
          { type: "image", source: { type: "url", url: "https://example.com/shot.png" } },
        ] }] },
      ],
    }, true, {}, null);
    const texts = out.conversationState.currentMessage.userInputMessage.userInputMessageContext.toolResults.map((r) => r.content[0].text);
    expect(texts).toEqual([`${MEDIA_OMITTED_TEXT.FILE}\n[Image: https://example.com/shot.png]`]);
    expect(JSON.stringify(out)).not.toContain(PDF_B64);
  });

  it("Antigravity's Claude envelope keeps a web image as its URL", () => {
    const out = translateRequest(FORMATS.OPENAI, FORMATS.ANTIGRAVITY, CLAUDE_MODEL,
      chatBody([{ type: "text", text: "Output:" }, imagePart("https://example.com/shot.png")]), true, {}, null);
    const response = out.request.contents.flatMap((c) => c.parts).find((p) => p.functionResponse);
    expect(response.functionResponse.response.result).toBe("Output:\n[Image: https://example.com/shot.png]");
  });
});
