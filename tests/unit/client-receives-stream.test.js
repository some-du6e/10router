// What shape the client gets back, given a custom endpoint's "Streaming" override.
import { describe, it, expect } from "vitest";
import { clientReceivesStream, alwaysStreams } from "../../open-sse/handlers/chatCore.js";

const creds = (stream) => ({ apiKey: "sk-test-1234567890", providerSpecificData: { baseUrl: "https://gw.example.com/v1", overrides: { stream } } });
const ask = (stream, override, provider = "openai-compatible-chat-x") => clientReceivesStream({
  body: { model: "m", messages: [], stream },
  provider, model: "m", sourceFormat: "openai",
  clientRawRequest: { headers: { accept: stream ? "text/event-stream" : "application/json" } },
  credentials: override ? creds(override) : null,
});

describe("clientReceivesStream with a streaming override", () => {
  it.each([
    [true, null, true],
    [false, null, false],
    [false, "always", false],
    [true, "always", true],
    [true, "never", true],
    [false, "never", false],
  ])("client stream=%s, override=%s -> %s", (stream, override, want) => {
    expect(ask(stream, override)).toBe(want);
  });

  // No accept header and no stream flag: the default is a stream, unless "always"
  // means the upstream is SSE that gets folded back to JSON for this client.
  it("always turns a no-preference client into JSON", () => {
    const bare = (override) => clientReceivesStream({ body: { model: "m", messages: [] }, provider: "openai-compatible-chat-x", model: "m", sourceFormat: "openai", clientRawRequest: { headers: {} }, credentials: override ? creds(override) : null });
    expect(bare(null)).toBe(true);
    expect(bare("always")).toBe(false);
    expect(bare("never")).toBe(true);
  });

  it("ignores the override on built-in providers", () => {
    expect(ask(false, "always", "openai")).toBe(false);
    expect(ask(true, "always", "openai")).toBe(true);
  });
});

// handleForcedSSEToJson only folds OpenAI SSE back to JSON. A Claude SSE reply
// would come back as an empty message, so "always" must not apply there.
describe("alwaysStreams", () => {
  const c = (extra = {}) => ({ providerSpecificData: { baseUrl: "https://gw.example.com/v1", overrides: { stream: "always" }, ...extra } });
  it("applies to an OpenAI upstream for an OpenAI client", () => {
    expect(alwaysStreams("openai-compatible-chat-x", "m", "openai", c())).toBe(true);
    expect(alwaysStreams("openai-compatible-chat-x", "m", "openai-responses", c())).toBe(true);
  });
  it("skips a Claude upstream", () => {
    expect(alwaysStreams("anthropic-compatible-x", "m", "openai", c())).toBe(false);
    expect(alwaysStreams("openai-compatible-chat-x", "claude-x", "openai", c({ modelRoutes: { "claude-x": "anthropic" } }))).toBe(false);
  });
  it("skips a Claude-format client", () => {
    expect(alwaysStreams("openai-compatible-chat-x", "m", "claude", c())).toBe(false);
  });
  it("keeps the client's choice when it can't apply", () => {
    const bare = { body: { model: "m", messages: [] }, provider: "anthropic-compatible-x", model: "m", sourceFormat: "openai", clientRawRequest: { headers: {} }, credentials: c() };
    expect(clientReceivesStream(bare)).toBe(true);
  });
});
