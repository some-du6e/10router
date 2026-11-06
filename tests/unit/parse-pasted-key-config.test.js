// Pasting a Claude Code settings snippet (or env lines) into the Add key
// dialog's key field fills the key and, where it differs from the endpoint's
// own, the key's endpoint URL. Anything else stays a plain key.
import { describe, it, expect } from "vitest";
import { parsePastedKeyConfig, describePastedKeyConfig } from "../../src/shared/utils/parsePastedKeyConfig.js";
import { getExecutor } from "../../open-sse/executors/index.js";

const ENDPOINT = "https://example.com/api/v1";

const SETTINGS = `{
  "env": {
    "ANTHROPIC_BASE_URL": "https://other.example.com/api",
    "ANTHROPIC_AUTH_TOKEN": "sk-xxx",
    "CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS": "1"
  }
}`;

describe("config shapes", () => {
  it("reads a settings.json with env", () => {
    expect(parsePastedKeyConfig(SETTINGS, { endpointUrl: ENDPOINT })).toEqual({
      apiKey: "sk-xxx",
      baseUrl: "https://other.example.com/api/v1",
      sameAsEndpoint: false,
      ignored: 1,
      badUrl: "",
    });
  });

  it("reads a full settings.json whose other settings aren't env variables", () => {
    const text = JSON.stringify({ model: "opus", permissions: { allow: [] }, env: { ANTHROPIC_API_KEY: "sk-xxx" } });
    expect(parsePastedKeyConfig(text)).toEqual({ apiKey: "sk-xxx", baseUrl: "", sameAsEndpoint: false, ignored: 0, badUrl: "" });
  });

  it("reads a bare env object, with trailing commas", () => {
    const text = `{ "ANTHROPIC_AUTH_TOKEN": "sk-xxx", "DISABLE_TELEMETRY": "1", }`;
    expect(parsePastedKeyConfig(text)).toMatchObject({ apiKey: "sk-xxx", ignored: 1 });
  });

  it("reads the env fragment copied out of settings.json", () => {
    const text = `"env": { "ANTHROPIC_AUTH_TOKEN": "sk-xxx" },`;
    expect(parsePastedKeyConfig(text)).toMatchObject({ apiKey: "sk-xxx" });
  });

  it("reads dotenv and shell lines with quotes and comments", () => {
    const text = [
      "# Claude Code",
      `export ANTHROPIC_BASE_URL="https://other.example.com/api/"`,
      "export ANTHROPIC_AUTH_TOKEN='sk-xxx'",
      "CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1 # betas off",
      "",
    ].join("\n");
    expect(parsePastedKeyConfig(text, { endpointUrl: ENDPOINT })).toEqual({
      apiKey: "sk-xxx",
      baseUrl: "https://other.example.com/api/v1",
      sameAsEndpoint: false,
      ignored: 1,
      badUrl: "",
    });
  });

  it("unescapes double-quoted values and accepts Windows forms", () => {
    expect(parsePastedKeyConfig(`export ANTHROPIC_AUTH_TOKEN="sk-\\"xxx"`).apiKey).toBe('sk-"xxx');
    expect(parsePastedKeyConfig("set ANTHROPIC_AUTH_TOKEN=sk-xxx").apiKey).toBe("sk-xxx");
    expect(parsePastedKeyConfig(`$env:ANTHROPIC_AUTH_TOKEN = "sk-xxx"`).apiKey).toBe("sk-xxx");
  });

  it("reads the Windows prefixes in any case", () => {
    expect(parsePastedKeyConfig(`$Env:ANTHROPIC_AUTH_TOKEN="sk-xxx"\n$Env:ANTHROPIC_BASE_URL="https://o.example.com/api"`)).toMatchObject({
      apiKey: "sk-xxx",
      baseUrl: "https://o.example.com/api/v1",
    });
    expect(parsePastedKeyConfig("SET ANTHROPIC_AUTH_TOKEN=sk-xxx").apiKey).toBe("sk-xxx");
    expect(parsePastedKeyConfig("Set ANTHROPIC_AUTH_TOKEN=sk-xxx").apiKey).toBe("sk-xxx");
    expect(parsePastedKeyConfig("Export ANTHROPIC_AUTH_TOKEN=sk-xxx").apiKey).toBe("sk-xxx");
  });

  it("takes the key from ANTHROPIC_AUTH_TOKEN, then ANTHROPIC_API_KEY, then OPENAI_API_KEY", () => {
    expect(parsePastedKeyConfig("OPENAI_API_KEY=sk-c\nANTHROPIC_API_KEY=sk-b\nANTHROPIC_AUTH_TOKEN=sk-a").apiKey).toBe("sk-a");
    expect(parsePastedKeyConfig("OPENAI_API_KEY=sk-c\nANTHROPIC_API_KEY=sk-b").apiKey).toBe("sk-b");
    expect(parsePastedKeyConfig("OPENAI_API_KEY=sk-c").apiKey).toBe("sk-c");
    expect(parsePastedKeyConfig(`ANTHROPIC_AUTH_TOKEN=""\nOPENAI_API_KEY=sk-c`).apiKey).toBe("sk-c");
  });

  it("trims the key, skips a blank one and drops an inline comment", () => {
    expect(parsePastedKeyConfig(`{"ANTHROPIC_AUTH_TOKEN":" sk-xxx "}`).apiKey).toBe("sk-xxx");
    expect(parsePastedKeyConfig(`{"ANTHROPIC_AUTH_TOKEN":"  ","OPENAI_API_KEY":"sk-c"}`).apiKey).toBe("sk-c");
    expect(parsePastedKeyConfig("ANTHROPIC_AUTH_TOKEN=sk-xxx # work account").apiKey).toBe("sk-xxx");
    expect(parsePastedKeyConfig(`ANTHROPIC_AUTH_TOKEN="sk-xxx" # work account`).apiKey).toBe("sk-xxx");
  });
});

describe("endpoint URL", () => {
  it("adds /v1 to ANTHROPIC_BASE_URL, which Claude Code gives without it", () => {
    const r = parsePastedKeyConfig("ANTHROPIC_AUTH_TOKEN=sk-xxx\nANTHROPIC_BASE_URL=https://Other.Example.com/api/", { endpointUrl: ENDPOINT });
    expect(r.baseUrl).toBe("https://other.example.com/api/v1");
  });

  it("keeps a version ANTHROPIC_BASE_URL already ends with", () => {
    const r = parsePastedKeyConfig("ANTHROPIC_AUTH_TOKEN=sk-xxx\nANTHROPIC_BASE_URL=https://other.example.com/api/v1/", { endpointUrl: ENDPOINT });
    expect(r.baseUrl).toBe("https://other.example.com/api/v1");
  });

  it("uses OPENAI_BASE_URL as given, since it already includes /v1", () => {
    const r = parsePastedKeyConfig("OPENAI_API_KEY=sk-xxx\nOPENAI_BASE_URL=https://other.example.com/v1/chat/completions", { endpointUrl: ENDPOINT });
    expect(r).toEqual({ apiKey: "sk-xxx", baseUrl: "https://other.example.com/v1", sameAsEndpoint: false, ignored: 0, badUrl: "" });
    const bare = parsePastedKeyConfig("OPENAI_API_KEY=sk-xxx\nOPENAI_BASE_URL=https://other.example.com/openai", { endpointUrl: ENDPOINT });
    expect(bare.baseUrl).toBe("https://other.example.com/openai");
  });

  it("takes the URL from the key's own family when both are set", () => {
    const text = "OPENAI_API_KEY=sk-xxx\nANTHROPIC_BASE_URL=https://a.example.com\nOPENAI_BASE_URL=https://o.example.com/v1";
    expect(parsePastedKeyConfig(text).baseUrl).toBe("https://o.example.com/v1");
    expect(parsePastedKeyConfig(text).ignored).toBe(1);
  });

  it("takes the endpoint's own API's key and URL when both are set", () => {
    const text = "ANTHROPIC_AUTH_TOKEN=sk-a\nANTHROPIC_BASE_URL=https://a.example.com\nOPENAI_API_KEY=sk-o\nOPENAI_BASE_URL=https://o.example.com/v1";
    expect(parsePastedKeyConfig(text, { apiType: "openai" })).toMatchObject({ apiKey: "sk-o", baseUrl: "https://o.example.com/v1", ignored: 2 });
    expect(parsePastedKeyConfig(text, { apiType: "anthropic" })).toMatchObject({ apiKey: "sk-a", baseUrl: "https://a.example.com/v1", ignored: 2 });
    // With only the other API's variables, those are used.
    expect(parsePastedKeyConfig(SETTINGS, { apiType: "openai" })).toMatchObject({ apiKey: "sk-xxx", baseUrl: "https://other.example.com/api/v1" });
  });

  it("leaves the other API's URL to the other API's key from the same paste", () => {
    const anthropicKey = "ANTHROPIC_API_KEY=sk-a\nOPENAI_API_KEY=sk-o\nOPENAI_BASE_URL=https://o.example.com/api/v1";
    expect(parsePastedKeyConfig(anthropicKey, { endpointUrl: ENDPOINT, apiType: "anthropic" })).toEqual({ apiKey: "sk-a", baseUrl: "", sameAsEndpoint: false, ignored: 2, badUrl: "" });
    const openaiKey = "OPENAI_API_KEY=sk-o\nANTHROPIC_AUTH_TOKEN=sk-a\nANTHROPIC_BASE_URL=https://a.example.com/anthropic";
    expect(parsePastedKeyConfig(openaiKey, { endpointUrl: ENDPOINT, apiType: "openai" })).toEqual({ apiKey: "sk-o", baseUrl: "", sameAsEndpoint: false, ignored: 2, badUrl: "" });
  });

  it("takes the endpoint's own API's URL from a URL-only paste that sets both", () => {
    const text = "ANTHROPIC_BASE_URL=https://a.example.com\nOPENAI_BASE_URL=https://o.example.com/v1";
    expect(parsePastedKeyConfig(text, { apiType: "openai" })).toMatchObject({ apiKey: "", baseUrl: "https://o.example.com/v1", ignored: 1 });
    expect(parsePastedKeyConfig(text, { apiType: "anthropic" })).toMatchObject({ apiKey: "", baseUrl: "https://a.example.com/v1", ignored: 1 });
  });

  it("sets no per-key URL when it is the endpoint's own", () => {
    for (const url of ["https://example.com/api", "https://example.com/api/", "https://EXAMPLE.com/api/v1", "https://example.com/api/v1/messages"]) {
      const r = parsePastedKeyConfig(`ANTHROPIC_AUTH_TOKEN=sk-xxx\nANTHROPIC_BASE_URL=${url}`, { endpointUrl: `${ENDPOINT}/` });
      expect(r, url).toEqual({ apiKey: "sk-xxx", baseUrl: "", sameAsEndpoint: true, ignored: 0, badUrl: "" });
    }
    const openai = parsePastedKeyConfig("OPENAI_API_KEY=sk-xxx\nOPENAI_BASE_URL=https://example.com/api/v1/", { endpointUrl: ENDPOINT });
    expect(openai).toMatchObject({ baseUrl: "", sameAsEndpoint: true });
  });

  it("matches an endpoint saved without a version too", () => {
    const r = parsePastedKeyConfig("ANTHROPIC_AUTH_TOKEN=sk-xxx\nANTHROPIC_BASE_URL=https://example.com/api", { endpointUrl: "https://example.com/api" });
    expect(r).toMatchObject({ baseUrl: "", sameAsEndpoint: true });
  });

  it("fills a URL with no key", () => {
    const r = parsePastedKeyConfig(`{"env":{"ANTHROPIC_BASE_URL":"https://other.example.com/api"}}`, { endpointUrl: ENDPOINT });
    expect(r).toEqual({ apiKey: "", baseUrl: "https://other.example.com/api/v1", sameAsEndpoint: false, ignored: 0, badUrl: "" });
  });

  it("ignores URLs where a key can't have its own (built-in providers)", () => {
    expect(parsePastedKeyConfig(SETTINGS, { keyUrl: false })).toEqual({ apiKey: "sk-xxx", baseUrl: "", sameAsEndpoint: false, ignored: 2, badUrl: "" });
    expect(parsePastedKeyConfig("ANTHROPIC_BASE_URL=https://other.example.com/api", { keyUrl: false })).toBeNull();
  });

  it("drops a URL that isn't http(s)", () => {
    expect(parsePastedKeyConfig("ANTHROPIC_BASE_URL=not a url")).toBeNull();
    expect(parsePastedKeyConfig("ANTHROPIC_AUTH_TOKEN=sk-xxx\nANTHROPIC_BASE_URL=ftp://example.com")).toMatchObject({ baseUrl: "", ignored: 0, badUrl: "ANTHROPIC_BASE_URL" });
  });

  // Requests must reach where Claude Code would have sent them: ANTHROPIC_BASE_URL + /v1/messages.
  it("routes requests where Claude Code would have sent them", () => {
    const { baseUrl } = parsePastedKeyConfig(SETTINGS, { endpointUrl: ENDPOINT });
    const credentials = { apiKey: "sk-xxx", providerSpecificData: { baseUrl, ownBaseUrl: true } };
    expect(getExecutor("anthropic-compatible-e2e").buildUrl("m", true, 0, credentials)).toBe("https://other.example.com/api/v1/messages");
    const openai = parsePastedKeyConfig("OPENAI_API_KEY=sk-xxx\nOPENAI_BASE_URL=https://other.example.com/v1", { endpointUrl: ENDPOINT });
    const oc = { apiKey: "sk-xxx", providerSpecificData: { baseUrl: openai.baseUrl, apiType: "chat", ownBaseUrl: true } };
    expect(getExecutor("openai-compatible-e2e").buildUrl("m", true, 0, oc)).toBe("https://other.example.com/v1/chat/completions");
  });
});

describe("plain keys stay plain", () => {
  const keys = [
    "sk-xxx",
    "  sk-xxx  ",
    "dGVzdC1rZXk=",
    "dGVzdA==",
    "abc=def=ghi",
    "{abc123",
    "{not json at all}",
    `{"ANTHROPIC_AUTH_TOKEN": "sk-xxx"`,
    `"quoted-key"`,
    "{}",
    `{"env": {}}`,
    `{"foo": "bar"}`,
    "[1, 2, 3]",
    "FOO=bar",
    "ANTHROPIC_AUTH_TOKEN=sk-xxx\nnot a line",
    // Shell one-liners: more than one value after the "=".
    "ANTHROPIC_BASE_URL=https://example.com/api ANTHROPIC_AUTH_TOKEN=sk-xxx claude",
    "export ANTHROPIC_BASE_URL=https://example.com/api ANTHROPIC_AUTH_TOKEN=sk-xxx",
    "ANTHROPIC_AUTH_TOKEN=sk-xxx ANTHROPIC_BASE_URL=https://example.com/api claude",
    `ANTHROPIC_BASE_URL="https://example.com/api" ANTHROPIC_AUTH_TOKEN="sk-xxx" claude`,
    "set ANTHROPIC_AUTH_TOKEN=sk-xxx && claude",
    "ANTHROPIC_AUTH_TOKEN=sk-xxx; claude",
    // Lines an <input> ran together (the breaks dropped or made spaces).
    "ANTHROPIC_BASE_URL=https://example.com/apiANTHROPIC_AUTH_TOKEN=sk-xxxclaude",
    "export ANTHROPIC_AUTH_TOKEN=sk-xxxexport ANTHROPIC_BASE_URL=https://example.com/apiclaude",
    "export ANTHROPIC_AUTH_TOKEN=sk-xxx export ANTHROPIC_BASE_URL=https://example.com/api claude",
    "",
  ];
  for (const k of keys) {
    it(`${JSON.stringify(k)} is not a config`, () => {
      expect(parsePastedKeyConfig(k, { endpointUrl: ENDPOINT })).toBeNull();
    });
  }
});

describe("hint", () => {
  it("names what was filled and counts the rest, without values", () => {
    const r = parsePastedKeyConfig(SETTINGS, { endpointUrl: ENDPOINT });
    const hint = describePastedKeyConfig(r);
    expect(hint).toBe("Filled from pasted config: key, endpoint URL. Ignored 1 other variable.");
    expect(hint).not.toContain("sk-xxx");
    expect(hint).not.toContain("example.com");
  });

  it("says when the URL is the endpoint's own", () => {
    const r = parsePastedKeyConfig("ANTHROPIC_AUTH_TOKEN=sk-xxx\nANTHROPIC_BASE_URL=https://example.com/api\nA=1\nB=2", { endpointUrl: ENDPOINT });
    expect(describePastedKeyConfig(r)).toBe("Filled from pasted config: key. Its URL is this endpoint's own, so the key uses that. Ignored 2 other variables.");
  });

  it("names a pasted URL it couldn't use", () => {
    const r = parsePastedKeyConfig("ANTHROPIC_AUTH_TOKEN=sk-xxx\nANTHROPIC_BASE_URL=ftp://other.example.com\nA=1", { endpointUrl: ENDPOINT });
    expect(describePastedKeyConfig(r)).toBe("Filled from pasted config: key. Its ANTHROPIC_BASE_URL isn't an http(s) URL, so the key uses this endpoint's. Ignored 1 other variable.");
  });

  it("asks for the key when there was none", () => {
    const r = parsePastedKeyConfig("ANTHROPIC_BASE_URL=https://other.example.com/api", { endpointUrl: ENDPOINT });
    expect(describePastedKeyConfig(r)).toBe("Filled from pasted config: endpoint URL. It has no key: paste the key here.");
  });

  it("says the entered key stays when the paste had none", () => {
    const r = parsePastedKeyConfig("ANTHROPIC_BASE_URL=https://other.example.com/api", { endpointUrl: ENDPOINT });
    expect(describePastedKeyConfig(r, { keptKey: true })).toBe("Filled from pasted config: endpoint URL. It has no key, so the key already entered stays.");
  });
});
