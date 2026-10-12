import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ synthesize: vi.fn(), comboModels: vi.fn(), credentials: vi.fn(), combo: vi.fn() }));
vi.mock("@/lib/localDb", () => ({ getSettings: async () => ({}) }));
vi.mock("@/sse/services/auth.js", () => ({
  extractApiKey: () => null, isValidApiKey: vi.fn(),
  getProviderCredentials: mocks.credentials, markAccountUnavailable: vi.fn(),
}));
vi.mock("@/sse/services/model.js", () => ({
  getModelInfo: async () => ({ provider: "google-tts", model: "en" }),
  getComboModels: mocks.comboModels, comboLookupName: (name) => name,
}));
vi.mock("@/sse/utils/logger.js", () => ({ request: vi.fn(), info: vi.fn() }));
vi.mock("open-sse/services/combo.js", () => ({ handleComboChat: mocks.combo }));
vi.mock("../../open-sse/handlers/ttsProviders/index.js", () => ({
  getTtsAdapter: () => ({ synthesize: mocks.synthesize }), synthesizeViaConfig: vi.fn(),
  VOICE_FETCHERS: {}, fetchEdgeTtsVoices: vi.fn(), fetchLocalDeviceVoices: vi.fn(), fetchElevenLabsVoices: vi.fn(),
}));

import { handleTts } from "@/sse/handlers/tts.js";

function request(body = {}, query = "") {
  return new Request(`http://router.test/v1/audio/speech${query}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "google-tts/en", input: "hello", ...body }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.comboModels.mockResolvedValue(null);
  mocks.synthesize.mockResolvedValue({ base64: "aGVsbG8=", format: "mp3" });
  mocks.combo.mockImplementation(({ body, models, handleSingleModel }) => handleSingleModel(body, models[0]));
});

describe("TTS response_format at JSON ingress", () => {
  it("returns base64 JSON when requested in the body", async () => {
    const response = await handleTts(request({ response_format: "json" }));
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/json");
    expect(await response.json()).toEqual({ audio: "aGVsbG8=", format: "mp3" });
    expect(mocks.synthesize).toHaveBeenCalledWith("hello", "en", undefined, "json", expect.any(Object));
  });

  it("keeps query parameters as an override", async () => {
    const response = await handleTts(request({ response_format: "json" }, "?response_format=mp3"));
    expect(response.headers.get("Content-Type")).toBe("audio/mp3");
    expect(await response.text()).toBe("hello");
  });

  it("supports the existing JSON query parameter", async () => {
    const response = await handleTts(request({}, "?response_format=json"));
    expect(await response.json()).toEqual({ audio: "aGVsbG8=", format: "mp3" });
  });

  it("defaults to binary audio", async () => {
    const response = await handleTts(request());
    expect(response.headers.get("Content-Type")).toBe("audio/mp3");
    expect(await response.text()).toBe("hello");
  });

  it("preserves the body format across combo dispatch", async () => {
    mocks.comboModels.mockResolvedValue(["google-tts/en"]);
    const response = await handleTts(request({ model: "speech-combo", response_format: "json" }));
    expect(await response.json()).toEqual({ audio: "aGVsbG8=", format: "mp3" });
    expect(mocks.combo).toHaveBeenCalledOnce();
  });

  it("passes an encoding format to adapters that support it", async () => {
    mocks.synthesize.mockResolvedValue({ base64: "aGVsbG8=", format: "wav" });
    const response = await handleTts(request({ response_format: "wav" }));
    expect(response.headers.get("Content-Type")).toBe("audio/wav");
    expect(mocks.synthesize).toHaveBeenCalledWith("hello", "en", undefined, "wav", expect.any(Object));
  });

  it.each([{}, [], true, 123, ""].map(response_format => ({ response_format })))("rejects invalid format $response_format before synthesis", async ({ response_format }) => {
    const response = await handleTts(request({ response_format }));
    expect(response.status).toBe(400);
    expect((await response.json()).error.message).toBe("response_format must be a non-empty string");
    expect(mocks.synthesize).not.toHaveBeenCalled();
  });
});
