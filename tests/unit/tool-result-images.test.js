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
  toolContentText,
  moveToolImagesToUserTurn,
} from "../../open-sse/translator/concerns/toolContent.js";
import { stripUnsupportedModalities } from "../../open-sse/translator/concerns/modality.js";
import { estimateInputTokens, estimateBillingInputTokens } from "../../open-sse/utils/usageTracking.js";
import { estimateAnthropicInputTokens } from "../../src/app/api/v1/messages/count_tokens/route.js";
import { capToolResultImages } from "../../open-sse/translator/concerns/toolImageCap.js";
import { GrokCliExecutor } from "../../open-sse/executors/grok-cli.js";
import { MEDIA_OMITTED_TEXT, IMAGE_TOKEN_ESTIMATE, TOOL_IMAGE_CAP } from "../../open-sse/config/mediaConfig.js";

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

describe("image cap for long sessions on a Claude-format target", () => {
  const { MAX_IMAGES, CHUNK } = TOOL_IMAGE_CAP;
  const session = (n) => {
    const input = [{ type: "message", role: "user", content: [{ type: "input_text", text: "use the computer" }] }];
    for (let i = 1; i <= n; i++) {
      input.push({ type: "function_call", call_id: `call_${i}`, name: "screenshot", arguments: "{}" });
      input.push({ type: "function_call_output", call_id: `call_${i}`, output: screenshotOutput(PNG_URL) });
    }
    return { model: CLAUDE_MODEL, input, tools: responsesBody().tools };
  };
  const toClaude = (body) => translateRequest(FORMATS.OPENAI_RESPONSES, FORMATS.CLAUDE, CLAUDE_MODEL, body, true, null, null);
  const shots = (out) => out.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : []))
    .filter((b) => b.type === "tool_result").map((b) => b.content[1]);

  it("100 screenshots: the oldest go in one chunk and the request stays under the cap", () => {
    const blocks = shots(toClaude(session(100)));
    expect(blocks).toHaveLength(100);
    const images = blocks.filter((b) => b.type === "image").length;
    expect(images).toBeLessThanOrEqual(MAX_IMAGES);
    expect(images).toBe(100 - CHUNK);
    expect(blocks.slice(0, CHUNK).every((b) => b.type === "text" && b.text === MEDIA_OMITTED_TEXT.EARLIER_IMAGE)).toBe(true);
    expect(blocks.slice(CHUNK).every((b) => b.type === "image")).toBe(true);
  });

  it("the next turn drops the same ones, so the prompt prefix stays the same", () => {
    const now = toClaude(session(100));
    const next = toClaude(session(101));
    expect(shots(next).filter((b) => b.type === "text")).toHaveLength(CHUNK);
    // Everything up to the 99th result: the 100th assistant turn holds the cache breakpoint.
    expect(withoutCache(next.messages.slice(0, 199))).toEqual(withoutCache(now.messages.slice(0, 199)));
  });

  it("under the cap nothing changes", () => {
    expect(shots(toClaude(session(MAX_IMAGES))).every((b) => b.type === "image")).toBe(true);
  });

  it("never drops user images or the newest tool images, and trims by size too", () => {
    const image = (n) => ({ type: "image", source: { type: "base64", media_type: "image/png", data: "y".repeat(n) } });
    const result = (i, n) => ({ type: "tool_result", tool_use_id: `t${i}`, content: [image(n)] });
    const userImages = [image(400), image(400), image(400)];
    const messages = [{ role: "user", content: [...userImages] }, { role: "user", content: [1, 2, 3, 4].map((i) => result(i, 400)) }];
    const original = messages[1].content[0].content;
    expect(capToolResultImages(messages, { MAX_IMAGES: 4, MAX_BYTES: 1e9, CHUNK: 2, KEEP_RECENT: 1 })).toBe(3);
    expect(messages[0].content).toEqual(userImages);
    expect(messages[1].content.map((r) => r.content[0].type)).toEqual(["text", "text", "text", "image"]);
    expect(original[0].type).toBe("image"); // content arrays are replaced, not edited

    const bySize = [{ role: "user", content: [1, 2, 3, 4, 5].map((i) => result(i, 4000)) }]; // 3000 bytes each
    expect(capToolResultImages(bySize, { MAX_IMAGES: 100, MAX_BYTES: 10_000, CHUNK: 1, KEEP_RECENT: 0 })).toBe(2);
  });
});
