/**
 * The account and combo loops give each attempt a shallow copy of the client's
 * body, so its messages, blocks and generationConfig are shared with the next
 * attempt. Code that changes them for one model must build new objects: the
 * next model (or key) has to get the request as the client sent it, and
 * request details record the client's messages by reference.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { executeMock, saveRequestDetailMock } = vi.hoisted(() => ({
  executeMock: vi.fn(),
  saveRequestDetailMock: vi.fn(() => Promise.resolve()),
}));

// Placeholder models with the capabilities each scenario needs.
const MODEL_CAPS = {
  "text-model": { vision: false },
  "vision-model": { vision: true },
  "plain-model": { reasoning: false },
  "thinking-model": { reasoning: true, thinkingFormat: "gemini-budget", thinkingRange: undefined },
};
vi.mock("../../open-sse/providers/capabilities.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    getCapabilitiesForModel: (provider, model) => ({
      ...actual.getCapabilitiesForModel(provider, model),
      ...MODEL_CAPS[String(model || "").replace(/\(.*\)$/, "")],
    }),
  };
});
vi.mock("../../open-sse/translator/concerns/image.js", async (importOriginal) => ({
  ...(await importOriginal()),
  fetchImageAsBase64: vi.fn(async () => ({ url: "data:image/png;base64,QUJD", mimeType: "image/png" })),
}));
vi.mock("../../open-sse/executors/index.js", () => ({
  getExecutor: vi.fn(() => ({ execute: executeMock, noAuth: true })),
}));
vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: vi.fn(async () => ({
    logClientRawRequest: vi.fn(), logRawRequest: vi.fn(), logTargetRequest: vi.fn(), logError: vi.fn(),
    logConvertedResponse: vi.fn(), logProviderResponse: vi.fn(), logOpenAIRequest: vi.fn(),
  })),
}));
vi.mock("../../open-sse/utils/streamHandler.js", async (importOriginal) => ({
  ...(await importOriginal()),
  createStreamController: vi.fn(() => ({
    signal: undefined, isConnected: () => true,
    handleComplete: vi.fn(), handleError: vi.fn(), handleDisconnect: vi.fn(), abort: vi.fn(),
  })),
}));
vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(() => Promise.resolve()),
  saveRequestDetail: saveRequestDetailMock,
  saveRequestUsage: vi.fn(() => Promise.resolve()),
}));

let handleChatCore;
let stripUnsupportedModalities;
let prefetchRemoteImages;
let applyThinking;
let translateRequest;
let FORMATS;

const NO_VISION = { vision: false, audioInput: true, pdf: true };
const IMAGE_URL = "https://img.example.test/cat.png";
const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), line: vi.fn() };

beforeAll(async () => {
  ({ handleChatCore } = await import("../../open-sse/handlers/chatCore.js"));
  ({ stripUnsupportedModalities } = await import("../../open-sse/translator/concerns/modality.js"));
  ({ prefetchRemoteImages } = await import("../../open-sse/translator/concerns/prefetch.js"));
  ({ applyThinking } = await import("../../open-sse/translator/concerns/thinkingUnified.js"));
  ({ translateRequest } = await import("../../open-sse/translator/index.js"));
  ({ FORMATS } = await import("../../open-sse/translator/formats.js"));
}, 30000);

beforeEach(() => {
  executeMock.mockReset();
  saveRequestDetailMock.mockClear();
});

// Run fn on a shallow copy of clientBody, as the attempt loop does, and check
// the client's body is still exactly what it was.
function onAttemptCopy(clientBody, fn) {
  const before = structuredClone(clientBody);
  const attempt = { ...clientBody };
  fn(attempt);
  expect(clientBody).toEqual(before);
  return attempt;
}

async function onAttemptCopyAsync(clientBody, fn) {
  const before = structuredClone(clientBody);
  const attempt = { ...clientBody };
  await fn(attempt);
  expect(clientBody).toEqual(before);
  return attempt;
}

describe("media stripping leaves the client's messages alone", () => {
  it("openai: drops the image from this attempt only", () => {
    const clientBody = { messages: [
      { role: "user", content: [{ type: "text", text: "what is this?" }, { type: "image_url", image_url: { url: IMAGE_URL } }], images: ["x"], attachments: [{ contentType: "image/png", url: IMAGE_URL }] },
    ] };
    const attempt = onAttemptCopy(clientBody, (body) => stripUnsupportedModalities(body, FORMATS.OPENAI, NO_VISION));
    expect(attempt.messages[0].content.some((b) => b.type === "image_url")).toBe(false);
    expect(attempt.messages[0].images).toBeUndefined();
    expect(attempt.messages[0].attachments).toEqual([]);
  });

  it("claude: drops images, including one inside a tool_result, from this attempt only", () => {
    const clientBody = { messages: [
      { role: "user", content: [
        { type: "tool_result", tool_use_id: "t1", content: [{ type: "image", source: { type: "url", url: IMAGE_URL } }] },
        { type: "image", source: { type: "url", url: IMAGE_URL } },
      ] },
    ] };
    const attempt = onAttemptCopy(clientBody, (body) => stripUnsupportedModalities(body, FORMATS.CLAUDE, NO_VISION));
    const [toolResult, ...rest] = attempt.messages[0].content;
    expect(toolResult.content.some((b) => b.type === "image")).toBe(false);
    expect(rest.some((b) => b.type === "image")).toBe(false);
  });

  it("responses: drops input_image from this attempt only", () => {
    const clientBody = { input: [
      { type: "function_call_output", call_id: "c1", output: [{ type: "input_image", image_url: IMAGE_URL }] },
      { role: "user", content: [{ type: "input_image", image_url: IMAGE_URL }] },
    ] };
    const attempt = onAttemptCopy(clientBody, (body) => stripUnsupportedModalities(body, FORMATS.OPENAI_RESPONSES, NO_VISION));
    expect(attempt.input[0].output.some((b) => b.type === "input_image")).toBe(false);
    expect(attempt.input[1].content.some((b) => b.type === "input_image")).toBe(false);
  });

  it("gemini and antigravity: drop inline images from this attempt only", () => {
    const parts = () => [{ text: "hi" }, { inlineData: { mimeType: "image/png", data: "QUJD" } }];
    const gemini = onAttemptCopy({ contents: [{ role: "user", parts: parts() }] },
      (body) => stripUnsupportedModalities(body, FORMATS.GEMINI, NO_VISION));
    expect(gemini.contents[0].parts.some((p) => p.inlineData)).toBe(false);
    const antigravity = onAttemptCopy({ request: { contents: [{ role: "user", parts: parts() }] } },
      (body) => stripUnsupportedModalities(body, FORMATS.ANTIGRAVITY, NO_VISION));
    expect(antigravity.request.contents[0].parts.some((p) => p.inlineData)).toBe(false);
  });

  it("a model's strip list drops the image from this attempt only", () => {
    const clientBody = {
      model: "text-model",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }, { type: "image_url", image_url: { url: IMAGE_URL } }] }],
    };
    const before = structuredClone(clientBody);
    const out = translateRequest(FORMATS.OPENAI, FORMATS.OPENAI, "text-model", { ...clientBody }, false, null, "openai", null, ["image"]);
    expect(JSON.stringify(out.messages)).not.toContain(IMAGE_URL);
    expect(clientBody).toEqual(before);
  });
});

describe("image prefetch leaves the client's messages alone", () => {
  it("openai, claude and gemini: inline the image in this attempt only", async () => {
    const openai = await onAttemptCopyAsync(
      { messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: IMAGE_URL, detail: "low" } }] }] },
      (body) => prefetchRemoteImages(body, FORMATS.OPENAI, FORMATS.OLLAMA));
    expect(openai.messages[0].content[0].image_url).toEqual({ url: "data:image/png;base64,QUJD", detail: "low" });

    const claude = await onAttemptCopyAsync(
      { messages: [{ role: "user", content: [{ type: "image", source: { type: "url", url: IMAGE_URL } }] }] },
      (body) => prefetchRemoteImages(body, FORMATS.CLAUDE, FORMATS.KIRO));
    expect(claude.messages[0].content[0].source).toEqual({ type: "base64", media_type: "image/png", data: "QUJD" });

    const gemini = await onAttemptCopyAsync(
      { contents: [{ role: "user", parts: [{ fileData: { mimeType: "image/png", fileUri: IMAGE_URL } }] }] },
      (body) => prefetchRemoteImages(body, FORMATS.GEMINI, FORMATS.GEMINI));
    expect(gemini.contents[0].parts[0]).toEqual({ inlineData: { mimeType: "image/png", data: "QUJD" } });
  });

  it("counts every converted image and fetches a repeated URL once", async () => {
    const { fetchImageAsBase64 } = await import("../../open-sse/translator/concerns/image.js");
    fetchImageAsBase64.mockClear();
    const block = () => ({ type: "image_url", image_url: { url: IMAGE_URL } });
    const body = { messages: [{ role: "user", content: [block(), block()] }] };
    expect(await prefetchRemoteImages(body, FORMATS.OPENAI, FORMATS.OLLAMA)).toBe(2);
    expect(fetchImageAsBase64).toHaveBeenCalledTimes(1);
  });
});

describe("Gemini thinking settings leave the client's generationConfig alone", () => {
  const generationConfig = () => ({ temperature: 0.2, maxOutputTokens: 100, thinkingConfig: { thinkingBudget: 512 } });

  it("a model without reasoning drops thinkingConfig from this attempt only", () => {
    const attempt = onAttemptCopy({ contents: [], generationConfig: generationConfig() },
      (body) => applyThinking(FORMATS.GEMINI, "plain-model", body, "gemini"));
    expect(attempt.generationConfig).toEqual({ temperature: 0.2, maxOutputTokens: 100 });
  });

  it("a model suffix replaces thinkingConfig in this attempt only", () => {
    const attempt = onAttemptCopy({ contents: [], generationConfig: generationConfig() },
      (body) => applyThinking(FORMATS.GEMINI, "thinking-model(high)", body, "gemini"));
    expect(attempt.generationConfig.thinkingConfig.thinkingBudget).not.toBe(512);
    expect(attempt.generationConfig.maxOutputTokens).toBeGreaterThan(100);
  });

  it("the request envelope's generationConfig is copied too", () => {
    const stripped = onAttemptCopy({ request: { contents: [], generationConfig: generationConfig() } },
      (body) => applyThinking(FORMATS.GEMINI_CLI, "plain-model", body, "gemini-cli"));
    expect(stripped.request.generationConfig.thinkingConfig).toBeUndefined();
    const raised = onAttemptCopy({ request: { contents: [], generationConfig: generationConfig() } },
      (body) => applyThinking(FORMATS.GEMINI_CLI, "thinking-model(high)", body, "gemini-cli"));
    expect(raised.request.generationConfig.thinkingConfig.thinkingBudget).not.toBe(512);
  });
});

// The scenarios from the bug, through chatCore with a failing upstream.
describe("the next combo model gets the client's request", () => {
  const sentBody = (call) => executeMock.mock.calls[call][0].body;
  const rows = () => saveRequestDetailMock.mock.calls.map((c) => c[0]);

  function failingUpstream() {
    executeMock.mockImplementation(async ({ body }) => ({
      response: new Response(JSON.stringify({ error: { message: "bad request" } }), { status: 400, headers: { "content-type": "application/json" } }),
      url: "https://upstream.example.test", headers: {}, transformedBody: body,
    }));
  }

  function attempt(clientBody, provider, model, sourceFormatOverride) {
    const body = { ...clientBody, model: `${provider}/${model}` };
    return handleChatCore({
      body,
      modelInfo: { provider, model },
      credentials: { apiKey: "k", providerSpecificData: {} },
      clientRawRequest: { endpoint: "/v1/chat/completions", body, headers: {} },
      connectionId: "conn-1",
      sourceFormatOverride,
      log,
    });
  }

  it("a vision model still gets the image after a text-only model dropped it", async () => {
    failingUpstream();
    const clientBody = {
      model: "combo-a", stream: false,
      messages: [{ role: "user", content: [{ type: "text", text: "what is this?" }, { type: "image_url", image_url: { url: IMAGE_URL } }] }],
    };
    const before = structuredClone(clientBody);

    await attempt(clientBody, "openai", "text-model");
    expect(JSON.stringify(sentBody(0).messages)).not.toContain(IMAGE_URL);

    await attempt(clientBody, "openai", "vision-model");
    expect(JSON.stringify(sentBody(1).messages)).toContain(IMAGE_URL);
    expect(clientBody).toEqual(before);
    expect(JSON.stringify(rows()[1].request.messages)).toContain(IMAGE_URL);
  });

  it("a thinking model still gets the client's thinkingConfig after a model without reasoning dropped it", async () => {
    failingUpstream();
    const clientBody = {
      contents: [{ role: "user", parts: [{ text: "hi" }] }],
      generationConfig: { temperature: 0.2, thinkingConfig: { thinkingBudget: 512 } },
    };
    const before = structuredClone(clientBody);

    await attempt(clientBody, "gemini", "plain-model", "gemini");
    expect(sentBody(0).generationConfig?.thinkingConfig).toBeUndefined();

    await attempt(clientBody, "gemini", "thinking-model", "gemini");
    expect(sentBody(1).generationConfig.thinkingConfig).toMatchObject({ thinkingBudget: 512 });
    expect(clientBody).toEqual(before);
  });
});
