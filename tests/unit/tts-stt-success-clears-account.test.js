// A TTS or STT success clears the account's error state, as chat does, so a key
// that works for speech isn't left with a streak of auth failures.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderCredentials: vi.fn(),
  markAccountUnavailable: vi.fn(),
  clearAccountError: vi.fn(),
  getModelInfo: vi.fn(),
  handleTtsCore: vi.fn(),
  handleSttCore: vi.fn(),
}));

vi.mock("@/sse/services/auth.js", () => ({
  getProviderCredentials: mocks.getProviderCredentials,
  markAccountUnavailable: mocks.markAccountUnavailable,
  clearAccountError: mocks.clearAccountError,
  extractApiKey: vi.fn(() => null),
  isValidApiKey: vi.fn(),
}));
vi.mock("@/lib/localDb", () => ({ getSettings: vi.fn(async () => ({ requireApiKey: false })) }));
vi.mock("@/sse/services/model.js", () => ({
  getModelInfo: mocks.getModelInfo,
  getComboModels: vi.fn(async () => null),
  comboLookupName: (name) => name,
}));
vi.mock("open-sse/handlers/ttsCore.js", () => ({ handleTtsCore: mocks.handleTtsCore }));
vi.mock("open-sse/handlers/sttCore.js", () => ({ handleSttCore: mocks.handleSttCore }));
vi.mock("@/sse/utils/logger.js", () => ({ request: vi.fn(), info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }));

import { handleTts } from "@/sse/handlers/tts.js";
import { handleStt } from "@/sse/handlers/stt.js";

const credentials = { connectionId: "conn-1", connectionName: "Test", apiKey: "sk-test-speech", _connection: { id: "conn-1", authFailCount: 3 } };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getProviderCredentials.mockResolvedValue(credentials);
  mocks.clearAccountError.mockResolvedValue(undefined);
});

describe("speech success clears the account error", () => {
  it("does so after a TTS success", async () => {
    mocks.getModelInfo.mockResolvedValue({ provider: "fish-audio", model: "voice-1" });
    mocks.handleTtsCore.mockResolvedValue({ success: true, response: new Response("audio") });
    const res = await handleTts(new Request("http://localhost/v1/audio/speech", {
      method: "POST", body: JSON.stringify({ model: "fish-audio/voice-1", input: "hi" }),
    }));
    expect(res.status).toBe(200);
    expect(mocks.clearAccountError).toHaveBeenCalledWith("conn-1", credentials, "voice-1");
  });

  it("does so after an STT success", async () => {
    mocks.getModelInfo.mockResolvedValue({ provider: "deepgram", model: "nova-3" });
    mocks.handleSttCore.mockResolvedValue({ success: true, response: new Response("{}") });
    const form = new FormData();
    form.set("model", "deepgram/nova-3");
    form.set("file", new Blob(["audio"]), "a.wav");
    const res = await handleStt(new Request("http://localhost/v1/audio/transcriptions", { method: "POST", body: form }));
    expect(res.status).toBe(200);
    expect(mocks.clearAccountError).toHaveBeenCalledWith("conn-1", credentials, "nova-3");
  });

  it("leaves it alone after a failure", async () => {
    mocks.getModelInfo.mockResolvedValue({ provider: "fish-audio", model: "voice-1" });
    mocks.handleTtsCore.mockResolvedValue({ success: false, status: 401, error: "Invalid API key" });
    mocks.markAccountUnavailable.mockResolvedValue({ shouldFallback: false });
    await handleTts(new Request("http://localhost/v1/audio/speech", {
      method: "POST", body: JSON.stringify({ model: "fish-audio/voice-1", input: "hi" }),
    }));
    expect(mocks.markAccountUnavailable).toHaveBeenCalled();
    expect(mocks.clearAccountError).not.toHaveBeenCalled();
  });

  it("keeps the TTS and STT success when clearing the errors fails", async () => {
    mocks.clearAccountError.mockRejectedValue(new Error("database is locked"));
    mocks.getModelInfo.mockResolvedValue({ provider: "fish-audio", model: "voice-1" });
    mocks.handleTtsCore.mockResolvedValue({ success: true, response: new Response("audio") });
    const tts = await handleTts(new Request("http://localhost/v1/audio/speech", {
      method: "POST", body: JSON.stringify({ model: "fish-audio/voice-1", input: "hi" }),
    }));
    expect(tts.status).toBe(200);

    mocks.getModelInfo.mockResolvedValue({ provider: "deepgram", model: "nova-3" });
    mocks.handleSttCore.mockResolvedValue({ success: true, response: new Response("{}") });
    const form = new FormData();
    form.set("model", "deepgram/nova-3");
    form.set("file", new Blob(["audio"]), "a.wav");
    const stt = await handleStt(new Request("http://localhost/v1/audio/transcriptions", { method: "POST", body: form }));
    expect(stt.status).toBe(200);
  });

  it("tells the failure handler which key the TTS request used", async () => {
    mocks.getModelInfo.mockResolvedValue({ provider: "fish-audio", model: "voice-1" });
    mocks.handleTtsCore.mockResolvedValue({ success: false, status: 401, error: "Invalid API key" });
    mocks.markAccountUnavailable.mockResolvedValue({ shouldFallback: false });
    await handleTts(new Request("http://localhost/v1/audio/speech", {
      method: "POST", body: JSON.stringify({ model: "fish-audio/voice-1", input: "hi" }),
    }));
    expect(mocks.markAccountUnavailable).toHaveBeenCalledWith("conn-1", 401, "Invalid API key", "fish-audio", "voice-1", null, "sk-test-speech");
  });
});
