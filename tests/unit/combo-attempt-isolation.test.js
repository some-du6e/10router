/**
 * The account and combo loops give each attempt a shallow copy of the client's
 * body ({ ...body, model }), so its messages, blocks and generationConfig are
 * the client's. chatCore copies them per attempt before anything edits them, so
 * the next attempt (another key or combo model) gets the request as the client
 * sent it, and request details record what the client sent.
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
  "audio-model": { audioInput: true },
  "audio-stripping-model": { audioInput: true },
  "thinking-model": { reasoning: true, thinkingFormat: "gemini-budget", thinkingRange: undefined },
};
const baseModel = (model) => String(model || "").replace(/\(.*\)$/, "");
vi.mock("../../open-sse/providers/capabilities.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    getCapabilitiesForModel: (provider, model) => ({
      ...actual.getCapabilitiesForModel(provider, model),
      ...MODEL_CAPS[baseModel(model)],
    }),
  };
});
// A model whose provider config strips audio before sending.
vi.mock("../../open-sse/config/providerModels.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    getModelStrip: (alias, model) => (model === "audio-stripping-model" ? ["audio"] : actual.getModelStrip(alias, model)),
  };
});
const IMAGE_URL = "https://img.example.test/cat.png";
const OTHER_IMAGE_URL = "https://img.example.test/dog.png";
const MISSING_IMAGE_URL = "https://img.example.test/missing.png";
vi.mock("../../open-sse/translator/concerns/image.js", async (importOriginal) => ({
  ...(await importOriginal()),
  fetchImageAsBase64: vi.fn(async (url) => (url.includes("missing") ? null : { url: "data:image/png;base64,QUJD", mimeType: "image/png" })),
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
let fetchImageAsBase64;

const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), line: vi.fn() };
// What each executor call was sent, snapshotted when it was sent.
const sent = [];
const sentJson = (call) => JSON.stringify(sent[call]);
const rows = () => saveRequestDetailMock.mock.calls.map((c) => c[0]);

beforeAll(async () => {
  ({ handleChatCore } = await import("../../open-sse/handlers/chatCore.js"));
  ({ fetchImageAsBase64 } = await import("../../open-sse/translator/concerns/image.js"));
}, 30000);

// The executor is mocked; a test that needs a real executor's request edits
// sets this to run them on the body the executor was handed.
let executorEdits = null;

beforeEach(() => {
  sent.length = 0;
  executorEdits = null;
  saveRequestDetailMock.mockClear();
  fetchImageAsBase64.mockClear();
  executeMock.mockReset();
  executeMock.mockImplementation(async (args) => {
    const body = executorEdits ? await executorEdits(args) : args.body;
    sent.push(structuredClone(body));
    return {
      response: new Response(JSON.stringify({ error: { message: "bad request" } }), { status: 400, headers: { "content-type": "application/json" } }),
      url: "https://upstream.example.test", headers: {}, transformedBody: body,
    };
  });
});

// One attempt, given the client's body the way the account and combo loops do.
function attempt(clientBody, provider, model, sourceFormatOverride, { headers = {}, signal = null } = {}) {
  const body = { ...clientBody, model: `${provider}/${model}` };
  return handleChatCore({
    body,
    modelInfo: { provider, model },
    credentials: { apiKey: "k", providerSpecificData: {} },
    clientRawRequest: { endpoint: "/v1/chat/completions", body, headers },
    connectionId: "conn-1",
    sourceFormatOverride,
    clientSignal: signal,
    log,
  });
}

// Run the attempts in order and check the client's body never changed.
async function runAttempts(clientBody, attempts) {
  const before = structuredClone(clientBody);
  for (const [provider, model, sourceFormat, options] of attempts) {
    await attempt(clientBody, provider, model, sourceFormat, options);
    expect(clientBody).toEqual(before);
  }
}

describe("the next combo model gets the client's media", () => {
  it("OpenAI: a vision model still gets the image a text-only model dropped", async () => {
    const clientBody = {
      model: "combo-a", stream: false,
      messages: [{
        role: "user",
        content: [{ type: "text", text: "what is this?" }, { type: "image_url", image_url: { url: IMAGE_URL } }],
        experimental_attachments: [{ contentType: "image/png", url: OTHER_IMAGE_URL }],
      }],
    };
    await runAttempts(clientBody, [["openai", "text-model"], ["openai", "vision-model"]]);
    expect(sentJson(0)).not.toContain(IMAGE_URL);
    expect(sentJson(1)).toContain(IMAGE_URL);
    // The first attempt's request details hold the client's message, not the stripped one.
    const recorded = rows()[0].request.messages[0];
    expect(JSON.stringify(recorded.content)).toContain(IMAGE_URL);
    expect(recorded.experimental_attachments).toHaveLength(1);
  });

  it("Claude: a vision model still gets the image inside a tool_result", async () => {
    const image = { type: "image", source: { type: "base64", media_type: "image/png", data: "QUJD" } };
    const clientBody = {
      model: "combo-a", max_tokens: 1024, stream: false,
      messages: [
        { role: "user", content: [{ type: "text", text: "take a screenshot" }] },
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "screenshot", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: [image] }, { type: "text", text: "what is on screen?" }] },
      ],
    };
    await runAttempts(clientBody, [["anthropic", "text-model", "claude"], ["anthropic", "vision-model", "claude"]]);
    expect(sentJson(0)).not.toContain('"QUJD"');
    expect(sentJson(1)).toContain('"QUJD"');
    expect(JSON.stringify(rows()[0].request.messages)).toContain('"QUJD"');
  });

  it("Gemini: a vision model still gets the inline image part", async () => {
    const clientBody = {
      contents: [{ role: "user", parts: [{ text: "what is this?" }, { inlineData: { mimeType: "image/png", data: "QUJD" } }] }],
    };
    await runAttempts(clientBody, [["gemini", "text-model", "gemini"], ["gemini", "vision-model", "gemini"]]);
    expect(sentJson(0)).not.toContain("inlineData");
    expect(sentJson(1)).toContain("inlineData");
  });

  it("a model's strip list leaves the audio, and a message it empties, for the next model", async () => {
    const audio = { type: "input_audio", input_audio: { data: "QUJD", format: "wav" } };
    const clientBody = {
      model: "combo-a", stream: false,
      messages: [{ role: "user", content: [audio] }, { role: "user", content: [{ type: "text", text: "transcribe it" }, audio] }],
    };
    await runAttempts(clientBody, [["openai", "audio-stripping-model"], ["openai", "audio-model"]]);
    expect(sentJson(0)).not.toContain("input_audio");
    expect(sentJson(1)).toContain("input_audio");
  });
});

describe("the next combo model gets the client's Gemini thinking settings", () => {
  it("a (level) suffix doesn't leave thinkingConfig or a raised maxOutputTokens behind", async () => {
    const clientBody = {
      contents: [{ role: "user", parts: [{ text: "hi" }] }],
      generationConfig: { temperature: 0.2, maxOutputTokens: 100 },
    };
    await runAttempts(clientBody, [["gemini", "thinking-model(high)", "gemini"], ["gemini", "thinking-model", "gemini"]]);
    expect(sent[0].generationConfig.thinkingConfig).toBeTruthy();
    expect(sent[0].generationConfig.maxOutputTokens).toBeGreaterThan(100);
    expect(sent[1].generationConfig).toEqual({ temperature: 0.2, maxOutputTokens: 100 });
  });

  it("the request envelope gets no generationConfig the client didn't send", async () => {
    const clientBody = { request: { contents: [{ role: "user", parts: [{ text: "hi" }] }] } };
    await runAttempts(clientBody, [["gemini-cli", "thinking-model(high)", "gemini-cli"], ["gemini-cli", "thinking-model", "gemini-cli"]]);
    expect(sent[0].request.generationConfig.thinkingConfig).toBeTruthy();
    expect(sent[1].request.generationConfig).toBeUndefined();
  });
});

describe("the next provider gets the client's Claude history", () => {
  // A Claude thinking signature: base64 starting with the 0x12 marker byte.
  const SIGNATURE = Buffer.from([0x12, 1, 2, 3]).toString("base64");

  it("native Claude keeps the signature and cache markers an Anthropic-compatible endpoint rewrote", async () => {
    const clientBody = {
      model: "combo-a", max_tokens: 1024, stream: false,
      messages: [
        { role: "user", content: [{ type: "text", text: "look it up", cache_control: { type: "ephemeral" } }] },
        { role: "assistant", content: [
          { type: "thinking", thinking: "I should look it up.", signature: SIGNATURE },
          { type: "tool_use", id: "t1", name: "lookup", input: { q: "x" } },
        ] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "found" }] },
      ],
    };
    await runAttempts(clientBody, [["anthropic-compatible-node", "model-a", "claude"], ["claude", "model-b", "claude"]]);
    const thinking = (call) => sent[call].messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).find((b) => b.type === "thinking");
    expect(thinking(0)?.signature).not.toBe(SIGNATURE);
    expect(thinking(1)?.signature).toBe(SIGNATURE);
    expect(rows()[1].request.messages[0].content[0].cache_control).toEqual({ type: "ephemeral" });
  });

  it("a tool call's object arguments are stringified for this attempt only", async () => {
    const clientBody = {
      model: "combo-a", stream: false,
      messages: [
        { role: "user", content: "weather?" },
        { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "weather", arguments: { city: "x" } } }] },
        { role: "tool", tool_call_id: "call_1", content: "sunny" },
      ],
    };
    await runAttempts(clientBody, [["openai", "model-a"], ["openai", "model-b"]]);
    expect(sent[1].messages[1].tool_calls[0].function.arguments).toBe('{"city":"x"}');
  });
});

describe("remote images for targets that need inline data", () => {
  const imageRequest = (urls) => ({
    model: "combo-a", stream: false,
    messages: [{ role: "user", content: [
      { type: "text", text: "compare" },
      ...urls.map((url, i) => (i % 2 ? { type: "image_url", image_url: url } : { type: "image_url", image_url: { url, detail: "low" } })),
    ] }],
  });
  const fetchesOf = (url) => fetchImageAsBase64.mock.calls.filter(([u]) => u === url).length;

  it("inline each image (object and string image_url) for every attempt, fetching each URL once per request", async () => {
    const clientBody = imageRequest([IMAGE_URL, OTHER_IMAGE_URL]);
    await runAttempts(clientBody, [["gemini", "vision-model"], ["gemini", "vision-model"]]);
    for (const call of [0, 1]) {
      expect(sentJson(call)).not.toContain(IMAGE_URL);
      expect(sentJson(call)).not.toContain(OTHER_IMAGE_URL);
      expect(sentJson(call)).toContain("QUJD");
    }
    expect(fetchesOf(IMAGE_URL)).toBe(1);
    expect(fetchesOf(OTHER_IMAGE_URL)).toBe(1);
  });

  it("tries an image whose fetch failed again on the next attempt, and the other one not", async () => {
    const clientBody = imageRequest([IMAGE_URL, MISSING_IMAGE_URL]);
    await runAttempts(clientBody, [["gemini", "vision-model"], ["gemini", "vision-model"]]);
    for (const call of [0, 1]) {
      expect(sentJson(call)).not.toContain(IMAGE_URL);
      expect(sentJson(call)).toContain("QUJD");
    }
    expect(fetchesOf(IMAGE_URL)).toBe(1);
    expect(fetchesOf(MISSING_IMAGE_URL)).toBe(2);
  });

  // A fusion judge or single-answer fallback gets a new message list (the
  // judge adds a turn), but the same client request and so the same signal.
  it("attempts with the same client signal but different message lists fetch each URL once", async () => {
    const signal = new AbortController().signal;
    const panelBody = imageRequest([IMAGE_URL]);
    const judgeBody = { ...panelBody, messages: [...panelBody.messages, { role: "user", content: "Judge the answers." }] };
    await runAttempts(panelBody, [["gemini", "vision-model", undefined, { signal }]]);
    await runAttempts(judgeBody, [["gemini", "vision-model", undefined, { signal }]]);
    expect(sentJson(1)).toContain("QUJD");
    expect(fetchesOf(IMAGE_URL)).toBe(1);
  });

  it("a new client request fetches again", async () => {
    await runAttempts(imageRequest([IMAGE_URL]), [["gemini", "vision-model", undefined, { signal: new AbortController().signal }]]);
    await runAttempts(imageRequest([IMAGE_URL]), [["gemini", "vision-model"]]);
    await runAttempts(imageRequest([IMAGE_URL]), [["gemini", "vision-model"]]);
    expect(fetchesOf(IMAGE_URL)).toBe(3);
  });

  it("a Gemini fileData part is inlined for every attempt and stays the client's", async () => {
    const clientBody = {
      contents: [{ role: "user", parts: [{ text: "what is this?" }, { fileData: { fileUri: IMAGE_URL, mimeType: "image/png" } }] }],
    };
    await runAttempts(clientBody, [["gemini", "vision-model", "gemini"], ["gemini", "vision-model", "gemini"]]);
    for (const call of [0, 1]) {
      expect(sentJson(call)).toContain("QUJD");
      expect(sentJson(call)).not.toContain(IMAGE_URL);
    }
    expect(fetchesOf(IMAGE_URL)).toBe(1);
  });

  it("Codex: an image_url in Responses input is downloaded once across attempts", async () => {
    const { CodexExecutor } = await import("../../open-sse/executors/codex.js");
    executorEdits = async ({ body, imageCacheKey }) => {
      await new CodexExecutor().prefetchImages(body, imageCacheKey);
      return body;
    };
    const clientBody = {
      model: "combo-a", stream: false,
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "what is this?" }, { type: "image_url", image_url: { url: IMAGE_URL } }] }],
    };
    await runAttempts(clientBody, [["codex", "vision-model", "openai-responses"], ["codex", "vision-model", "openai-responses"]]);
    for (const call of [0, 1]) expect(sentJson(call)).toContain("data:image/png;base64,QUJD");
    expect(fetchesOf(IMAGE_URL)).toBe(1);
  });
});

// Edits real executors make to the body they're handed: the executor is
// mocked, so these run the real executor's request edits on that body.
describe("executor edits stay in the attempt", () => {
  it("Codex: system roles, stored item ids and tool shapes are rewritten for this attempt only", async () => {
    const { CodexExecutor } = await import("../../open-sse/executors/codex.js");
    executorEdits = ({ model, body, stream, credentials }) => new CodexExecutor().transformRequest(model, body, stream, credentials);
    const clientBody = {
      model: "combo-a", stream: false,
      input: [
        { type: "message", role: "system", content: [{ type: "input_text", text: "be brief" }] },
        { type: "message", id: "msg_0123456789abcdef", role: "user", content: [{ type: "input_text", text: "weather?" }] },
      ],
      tools: [{ type: "function", function: { name: "weather", description: "Look up the weather", parameters: { type: "object", properties: {} } } }],
    };
    await runAttempts(clientBody, [["codex", "model-a", "openai-responses"], ["codex", "model-b", "openai-responses"]]);
    expect(sent[1].input[0].role).toBe("developer");
    expect(sent[1].tools[0]).toMatchObject({ type: "function", name: "weather" });
  });

  it("Grok CLI: its encrypted-reasoning include stays in the attempt", async () => {
    const { GrokCliExecutor } = await import("../../open-sse/executors/grok-cli.js");
    executorEdits = ({ model, body, stream, credentials }) => (
      model === "grok-model" ? new GrokCliExecutor().transformRequest(model, body, stream, credentials) : body
    );
    const clientBody = {
      model: "combo-a", stream: false,
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
      include: ["file_search_call.results"],
    };
    await runAttempts(clientBody, [["grok-cli", "grok-model", "openai-responses"], ["codex", "model-b", "openai-responses"]]);
    expect(sent[0].include).toContain("reasoning.encrypted_content");
    expect(sent[1].include).toEqual(["file_search_call.results"]);
  });

  it("Antigravity: the system instruction rewrite stays in the attempt", async () => {
    const { AntigravityExecutor } = await import("../../open-sse/executors/antigravity.js");
    executorEdits = ({ model, body, stream, credentials }) => new AntigravityExecutor().transformRequest(model, body, stream, credentials);
    const clientBody = {
      project: "project-a",
      request: {
        systemInstruction: { role: "user", parts: [{ text: "You follow the opencode style guide." }] },
        contents: [{ role: "user", parts: [{ text: "hi" }] }],
      },
    };
    await runAttempts(clientBody, [["antigravity", "model-a", "antigravity"], ["antigravity", "model-b", "antigravity"]]);
    expect(sentJson(1)).toContain("antigravity style guide");
  });

  it("Antigravity: a vision model still gets the image a text-only model dropped from the envelope", async () => {
    const clientBody = {
      project: "project-a",
      request: { contents: [{ role: "user", parts: [{ text: "what is this?" }, { inlineData: { mimeType: "image/png", data: "QUJD" } }] }] },
    };
    await runAttempts(clientBody, [["antigravity", "text-model", "antigravity"], ["antigravity", "vision-model", "antigravity"]]);
    expect(sentJson(0)).not.toContain("inlineData");
    expect(sentJson(1)).toContain("inlineData");
  });

  it("Claude passthrough: the cache anchors on system blocks and tools stay in the attempt", async () => {
    const clientBody = {
      model: "combo-a", max_tokens: 1024, stream: false,
      system: [{ type: "text", text: "You are terse.", cache_control: { type: "ephemeral" } }, { type: "text", text: "Answer in English." }],
      tools: [{ name: "lookup", description: "Look something up", input_schema: { type: "object", properties: {} } }],
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    };
    const claudeCli = { headers: { "user-agent": "claude-cli/2.0.0" } };
    await runAttempts(clientBody, [["anthropic", "model-a", "claude", claudeCli], ["anthropic", "model-b", "claude", claudeCli]]);
    expect(sent[1].system[1].cache_control).toBeTruthy();
    expect(sent[1].tools[0].cache_control).toBeTruthy();
  });
});
