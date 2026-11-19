// Self-hosted TTS gets an audio format it can serve, and a request a server
// rejects tries the next connection and locks none.
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

const connection = (id, baseUrl) => ({ connectionId: id, connectionName: id, apiKey: "any", providerSpecificData: { baseUrl } });
const serverA = connection("conn-a", "http://a.test");
const serverB = connection("conn-b", "http://b.test");
const audio = new Uint8Array([1, 2, 3]);
const audioBase64 = Buffer.from(audio).toString("base64");
let connections;
let upstream;

function speech(body) {
  return new Request("http://router.test/v1/audio/speech", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "selfhosted-tts/kokoro/af_heart", input: "hello", ...body }),
  });
}
const sentFormat = (call = 0) => JSON.parse(upstream.mock.calls[call][1].body).response_format;
const hosts = () => upstream.mock.calls.map(([url]) => new URL(url).host);

beforeEach(() => {
  vi.clearAllMocks();
  connections = [serverA];
  // Like getProviderCredentials: the first connection not excluded, else null.
  mocks.credentials.mockImplementation(async (_provider, excluded) => connections.find((c) => !excluded.has(c.connectionId)) ?? null);
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
    const result = await selfhostedTts.synthesize("hello", "kokoro", serverA, "json");
    expect(sentFormat()).toBe("mp3");
    expect(result).toEqual({ base64: audioBase64, format: "mp3" });
  });

  it("returns base64 mp3 for a body response_format of json", async () => {
    const response = await handleTts(speech({ response_format: "json" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ audio: audioBase64, format: "mp3" });
    expect(sentFormat()).toBe("mp3");
  });

  it("passes an audio format through, trimmed and lowercased", async () => {
    const response = await handleTts(speech({ response_format: " WAV " }));
    expect(response.headers.get("Content-Type")).toBe("audio/wav");
    expect(sentFormat()).toBe("wav");
  });

  it("labels the audio with the upstream's Content-Type over the requested format", async () => {
    upstream.mockResolvedValue(new Response(audio, { headers: { "Content-Type": "audio/wav" } }));
    const response = await handleTts(speech({ response_format: "json" }));
    expect(await response.json()).toEqual({ audio: audioBase64, format: "wav" });
  });
});

describe("self-hosted TTS errors", () => {
  it.each([400, 422])("answers an upstream %i about the request with a 400 and locks no connection", async (status) => {
    upstream.mockResolvedValue(Response.json({ detail: "unsupported format" }, { status }));
    const response = await handleTts(speech({ response_format: "flac" }));
    expect(response.status).toBe(400);
    expect((await response.json()).error.message).toBe("unsupported format");
    expect(mocks.markUnavailable).not.toHaveBeenCalled();
  });

  it.each([
    [{ detail: [{ msg: "format not supported" }] }, "format not supported"],
    [{ detail: { message: "voice not found" } }, "voice not found"],
  ])("passes a FastAPI detail body %j on to the client", async (body, message) => {
    upstream.mockResolvedValue(Response.json(body, { status: 422 }));
    const response = await handleTts(speech({}));
    expect(response.status).toBe(400);
    expect((await response.json()).error.message).toBe(message);
  });

  it("tries the next connection when one server rejects the request", async () => {
    connections = [serverA, serverB];
    upstream.mockImplementation(async (url) => (new URL(url).host === "a.test"
      ? Response.json({ detail: "unsupported format" }, { status: 422 })
      : new Response(audio)));
    const response = await handleTts(speech({ response_format: "flac" }));
    expect(response.status).toBe(200);
    expect(hosts()).toEqual(["a.test", "b.test"]);
    expect(mocks.markUnavailable).not.toHaveBeenCalled();
  });

  it("answers 400 and locks nothing when every connection rejects the request", async () => {
    connections = [serverA, serverB];
    upstream.mockImplementation(async () => Response.json({ detail: "unsupported format" }, { status: 422 }));
    const response = await handleTts(speech({ response_format: "flac" }));
    expect(response.status).toBe(400);
    expect((await response.json()).error.message).toBe("unsupported format");
    expect(hosts()).toEqual(["a.test", "b.test"]);
    expect(mocks.markUnavailable).not.toHaveBeenCalled();
  });

  it("still locks a connection whose 400 is about its key", async () => {
    upstream.mockResolvedValue(Response.json({ error: { message: "Invalid API key" } }, { status: 400 }));
    const response = await handleTts(speech({}));
    expect(response.status).toBe(502);
    expect(mocks.markUnavailable).toHaveBeenCalledWith("conn-a", 502, "Invalid API key", "selfhosted-tts", "kokoro/af_heart", null, "any");
  });

  it("still treats an upstream server error as the connection's failure", async () => {
    upstream.mockResolvedValue(new Response("down", { status: 500 }));
    const response = await handleTts(speech({}));
    expect(response.status).toBe(502);
    expect(mocks.markUnavailable).toHaveBeenCalledWith("conn-a", 502, expect.any(String), "selfhosted-tts", "kokoro/af_heart", null, "any");
  });
});
