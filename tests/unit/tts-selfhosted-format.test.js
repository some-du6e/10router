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
import { formatFromContentType } from "../../open-sse/handlers/ttsProviders/_base.js";
import { FORMAT_HANDLERS } from "../../open-sse/handlers/ttsProviders/genericFormats.js";

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

  it.each([
    [{ error: "Unsupported format" }, "Unsupported format"],
    [{ error: { message: { code: 1 } }, message: 42, detail: "voice not found" }, "voice not found"],
  ])("reads the message of error body %j as a string", async (body, message) => {
    upstream.mockResolvedValue(Response.json(body, { status: 422 }));
    const response = await handleTts(speech({}));
    expect(response.status).toBe(400);
    expect((await response.json()).error.message).toBe(message);
  });

  it("never reports an object as the message", async () => {
    upstream.mockResolvedValue(Response.json({ error: { message: { code: 1 } } }, { status: 422 }));
    const response = await handleTts(speech({}));
    expect((await response.json()).error.message).not.toContain("[object Object]");
  });

  it("returns instead of looping when an excluded connection comes back", async () => {
    // Ignores the exclusions three times, then runs out, so a missing guard
    // shows up as extra upstream calls rather than a hang.
    mocks.credentials.mockReset();
    mocks.credentials
      .mockResolvedValueOnce(serverA).mockResolvedValueOnce(serverA).mockResolvedValueOnce(serverA)
      .mockResolvedValue(null);
    upstream.mockImplementation(async () => Response.json({ detail: "unsupported format" }, { status: 422 }));
    const response = await handleTts(speech({}));
    expect(response.status).toBe(400);
    expect(upstream).toHaveBeenCalledTimes(2);
  });

  it("answers with the first server's message when two reject differently", async () => {
    connections = [serverA, serverB];
    upstream.mockImplementation(async (url) => Response.json({ detail: `${new URL(url).host} says no` }, { status: 422 }));
    const response = await handleTts(speech({}));
    expect(response.status).toBe(400);
    expect((await response.json()).error.message).toBe("a.test says no");
  });

  it.each([
    [{ statusCode: 400, error: "Bad Request", message: "Invalid API key" }, "Invalid API key"],
    [{ error: "invalid_request", detail: "voice not found" }, "voice not found"],
  ])("prefers the real reason over a status-text error in %j", async (body, message) => {
    upstream.mockImplementation(async () => Response.json(body, { status: 400 }));
    const result = await selfhostedTts.synthesize("hello", "kokoro", serverA, "mp3").catch((err) => err);
    expect(result.message).toBe(message);
  });

  it("still locks a framework-style 400 whose message is about the key", async () => {
    upstream.mockImplementation(async () => Response.json({ statusCode: 400, error: "Bad Request", message: "Invalid API key" }, { status: 400 }));
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

describe("self-hosted TTS rejection when the other connections are locked", () => {
  const locked = { allRateLimited: true, retryAfter: new Date(Date.now() + 30_000).toISOString(), retryAfterHuman: "30s", lastError: "down", lastErrorCode: 502 };
  const serverError = () => new Response("down", { status: 500 });
  const rejection = () => Response.json({ detail: "A rejects this" }, { status: 422 });

  beforeEach(() => {
    mocks.markUnavailable.mockResolvedValue({ shouldFallback: true });
    // Like getProviderCredentials once a locked connection is all that's left.
    mocks.credentials.mockImplementation(async (_provider, excluded) => connections.find((c) => !excluded.has(c.connectionId)) ?? locked);
  });

  it.each([
    ["A rejects, then B fails", [serverA, serverB]],
    ["B fails, then A rejects", [serverB, serverA]],
    ["A rejects while B is locked from earlier", [serverA]],
  ])("%s: 400 with A's message and no Retry-After", async (_name, order) => {
    connections = order;
    upstream.mockImplementation(async (url) => (new URL(url).host === "a.test" ? rejection() : serverError()));
    const response = await handleTts(speech({}));
    expect(response.status).toBe(400);
    expect(response.headers.get("Retry-After")).toBeNull();
    expect((await response.json()).error.message).toBe("A rejects this");
  });
});

describe("formatFromContentType", () => {
  it.each([
    ["audio/opus", "opus"], ["audio/aac", "aac"], ["audio/flac", "flac"], ["audio/pcm", "pcm"],
    ["audio/wav", "wav"], ["audio/mpeg", "mp3"], ["audio/ogg; codecs=opus", "ogg"],
    ["application/octet-stream", "wav"], [null, "wav"],
  ])("%s → %s", (contentType, format) => {
    expect(formatFromContentType(contentType, "wav")).toBe(format);
  });
});

describe("a config-driven adapter on the shared helpers", () => {
  const deepgram = (overrides = {}) => FORMAT_HANDLERS.deepgram({ baseUrl: "http://deepgram.test/v1/speak", apiKey: "k", text: "hello", ...overrides });

  it("labels its audio by the upstream Content-Type", async () => {
    upstream.mockResolvedValue(new Response(new Uint8Array(200), { headers: { "Content-Type": "audio/flac" } }));
    expect((await deepgram()).format).toBe("flac");
  });

  it("throws the upstream's string error", async () => {
    upstream.mockResolvedValue(Response.json({ error: "Unsupported format" }, { status: 400 }));
    await expect(deepgram()).rejects.toThrow(/^Unsupported format$/);
  });
});
