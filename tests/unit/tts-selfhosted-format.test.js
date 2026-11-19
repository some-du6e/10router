// Self-hosted TTS gets an audio format it can serve, and a request it rejects
// goes back to the client as a 400 without locking the connection.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ credentials: vi.fn(), markUnavailable: vi.fn(), clearError: vi.fn() }));
vi.mock("@/lib/localDb", () => ({ getSettings: async () => ({}) }));
vi.mock("@/sse/services/auth.js", () => ({
  extractApiKey: () => null, isValidApiKey: vi.fn(),
  getProviderCredentials: mocks.credentials, markAccountUnavailable: mocks.markUnavailable, clearAccountError: mocks.clearError,
}));
vi.mock("@/sse/services/model.js", () => ({
  getModelInfo: async () => ({ provider: "selfhosted-tts", model: "kokoro/af_heart" }),
  getComboModels: async () => null, comboLookupName: (name) => name,
}));
vi.mock("@/sse/utils/logger.js", () => ({ request: vi.fn(), info: vi.fn(), warn: vi.fn() }));

import { handleTts } from "@/sse/handlers/tts.js";
import selfhostedTts from "../../open-sse/handlers/ttsProviders/selfhostedTts.js";

const credentials = { connectionId: "conn-1", connectionName: "local", apiKey: "any", providerSpecificData: { baseUrl: "http://tts.test" } };
const audio = new Uint8Array([1, 2, 3]);
const audioBase64 = Buffer.from(audio).toString("base64");
let upstream;

function speech(body) {
  return new Request("http://router.test/v1/audio/speech", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "selfhosted-tts/kokoro/af_heart", input: "hello", ...body }),
  });
}
const sentFormat = (call = 0) => JSON.parse(upstream.mock.calls[call][1].body).response_format;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.credentials.mockResolvedValue(credentials);
  mocks.markUnavailable.mockResolvedValue({ shouldFallback: false });
  mocks.clearError.mockResolvedValue(undefined);
  upstream = vi.fn(async () => new Response(audio));
  vi.stubGlobal("fetch", upstream);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("self-hosted TTS response formats", () => {
  it("asks the upstream for mp3 when the client wants the json wrapper", async () => {
    const result = await selfhostedTts.synthesize("hello", "kokoro", credentials, "json");
    expect(sentFormat()).toBe("mp3");
    expect(result).toEqual({ base64: audioBase64, format: "mp3" });
  });

  it("returns base64 mp3 for a body response_format of json", async () => {
    const response = await handleTts(speech({ response_format: "json" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ audio: audioBase64, format: "mp3" });
    expect(sentFormat()).toBe("mp3");
    expect(mocks.credentials).toHaveBeenCalled();
  });

  it("passes an audio format through, trimmed and lowercased", async () => {
    const response = await handleTts(speech({ response_format: " WAV " }));
    expect(response.headers.get("Content-Type")).toBe("audio/wav");
    expect(sentFormat()).toBe("wav");
  });

  it.each([400, 422])("answers an upstream %i about the request with a 400 and locks no connection", async (status) => {
    upstream.mockResolvedValue(Response.json({ detail: "bad format" }, { status }));
    const response = await handleTts(speech({ response_format: "made-up" }));
    expect(response.status).toBe(400);
    expect(mocks.markUnavailable).not.toHaveBeenCalled();
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it("still treats an upstream server error as the connection's failure", async () => {
    upstream.mockResolvedValue(new Response("down", { status: 500 }));
    const response = await handleTts(speech({}));
    expect(response.status).toBe(502);
    expect(mocks.markUnavailable).toHaveBeenCalledWith("conn-1", 502, expect.any(String), "selfhosted-tts", "kokoro/af_heart", null, "any");
  });
});
