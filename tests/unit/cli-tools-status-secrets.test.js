import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The status GETs feed /api/cli-tools/all-statuses, which remote dashboard
// sessions reach. They must return the fields the cards read, never the
// host's other keys, tokens, env values or headers.

const OWN_KEY = "sk-own-client-key-0001";
const SECRETS = [
  "sk-placeholder-foreign-key",
  "sk-placeholder-env-token",
  "sk-placeholder-header-token",
  "sk-placeholder-helper-token",
  "sk-placeholder-own-key-in-file",
  "sk-placeholder-grok-key",
  "sk-placeholder-cli-token",
];

vi.mock("@/lib/localDb", () => ({
  getApiKeys: vi.fn(async () => [{ id: "k1", key: OWN_KEY, isActive: true }]),
}));

const originalHome = process.env.HOME;
const originalXdg = process.env.XDG_CONFIG_HOME;
let home;

const write = (rel, content) => {
  const file = path.join(home, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content, null, 2));
};

beforeAll(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "10r-cli-status-"));
  process.env.HOME = home;
  process.env.XDG_CONFIG_HOME = path.join(home, ".config");

  write(".claude/settings.json", {
    apiKeyHelper: "echo sk-placeholder-helper-token",
    env: {
      ANTHROPIC_BASE_URL: "http://localhost:20128/v1",
      ANTHROPIC_AUTH_TOKEN: "sk-placeholder-foreign-key",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "cc/opus-placeholder",
      CLAUDE_CODE_MAX_CONTEXT_TOKENS: "200000",
      OTHER_SERVICE_TOKEN: "sk-placeholder-env-token",
    },
  });

  write(".config/opencode/opencode.json", {
    model: "10router/m1",
    agent: { explorer: { model: "10router/m2" } },
    provider: {
      "10router": { options: { baseURL: "http://localhost:20128/v1", apiKey: "sk-placeholder-own-key-in-file" }, models: { m1: {} } },
      openai: { options: { apiKey: "sk-placeholder-foreign-key" } },
    },
    mcp: { remote: { headers: { Authorization: "Bearer sk-placeholder-header-token" } } },
  });

  write(
    ".codex/config.toml",
    [
      'model = "cx/model-placeholder"',
      'model_provider = "10router"',
      "",
      "[agents]",
      'default_subagent_model = "cx/sub-placeholder"',
      "",
      "[model_providers.10router]",
      'name = "10router"',
      'base_url = "http://localhost:20128/v1"',
      'wire_api = "responses"',
      "",
      "[model_providers.other]",
      'base_url = "https://other.example.com/v1"',
      'http_headers = { Authorization = "Bearer sk-placeholder-header-token" }',
      "",
      "[mcp_servers.tool.env]",
      'TOKEN = "sk-placeholder-env-token"',
      "",
    ].join("\n")
  );

  write(".factory/settings.json", {
    customModels: [
      { id: "custom:10router-0", index: 0, model: "m1", baseUrl: "http://localhost:20128/v1", apiKey: "sk-placeholder-own-key-in-file" },
      { id: "custom:other-0", model: "x", baseUrl: "https://other.example.com", apiKey: "sk-placeholder-foreign-key" },
    ],
  });

  write(".openclaw/openclaw.json", {
    agents: {
      defaults: { model: { primary: "10router/m1" } },
      list: [{ id: "a1", name: "A1", env: { TOKEN: "sk-placeholder-env-token" } }],
    },
    models: {
      providers: {
        "10router": { baseUrl: "http://localhost:20128/v1", apiKey: OWN_KEY },
        other: { baseUrl: "https://other.example.com", apiKey: "sk-placeholder-foreign-key" },
      },
    },
  });

  write(".config/Code/User/chatLanguageModels.json", [
    { name: "10router", apiKey: "sk-placeholder-own-key-in-file", models: [{ id: "m1", url: "http://localhost:20128/v1/chat/completions" }] },
    { name: "other", apiKey: "sk-placeholder-foreign-key", models: [{ id: "x" }] },
  ]);

  write(
    ".hermes/config.yaml",
    'model:\n  default: "m1"\n  provider: "custom"\n  base_url: "http://localhost:20128/v1"\n  api_key: "sk-placeholder-foreign-key"\n'
  );

  write(
    ".deepseek/config.toml",
    'provider = "openai"\n\n[providers.openai]\nbase_url = "http://localhost:20128/v1"\napi_key = "sk-placeholder-foreign-key"\nmodel = "m1"\n'
  );

  write(
    ".jcode/config.toml",
    '[providers.10router]\nbase_url = "http://localhost:20128/v1"\ndefault_model = "m1"\napi_key = "sk-placeholder-own-key-in-file"\n\n[providers.other]\napi_key = "sk-placeholder-foreign-key"\n'
  );

  write(".config/Claude-3p/configLibrary/_meta.json", { appliedId: "cfg" });
  write(".config/Claude-3p/configLibrary/cfg.json", {
    inferenceProvider: "gateway",
    inferenceGatewayBaseUrl: "http://localhost:20128/v1",
    inferenceGatewayApiKey: "sk-placeholder-own-key-in-file",
    inferenceModels: ["m1"],
    managedMcpServers: [
      { name: "files", url: "http://localhost:20128/api/mcp/files/sse", headers: { "x-9r-cli-token": "sk-placeholder-cli-token" } },
    ],
  });

  // Grok Build: written through its own route, which stores the key in the section.
  const { POST } = await import("../../src/app/api/cli-tools/grok-build-settings/route.js");
  await POST(new Request("http://localhost/x", {
    method: "POST",
    body: JSON.stringify({ baseUrl: "http://localhost:20128", apiKey: "sk-placeholder-grok-key", model: "m1" }),
  }));
  expect(fs.readFileSync(path.join(home, ".grok", "config.toml"), "utf8")).toContain("sk-placeholder-grok-key");
});

afterAll(() => {
  process.env.HOME = originalHome;
  if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalXdg;
  fs.rmSync(home, { recursive: true, force: true });
});

const status = async (route) => {
  const { GET } = await import(`../../src/app/api/cli-tools/${route}/route.js`);
  return (await GET()).json();
};

const expectNoSecrets = (body) => {
  const text = JSON.stringify(body);
  for (const secret of SECRETS) expect(text).not.toContain(secret);
};

describe("CLI tool status responses carry only what the cards read", () => {
  it("all-statuses returns none of the host's keys, tokens, env values or headers", async () => {
    const { GET } = await import("../../src/app/api/cli-tools/all-statuses/route.js");
    const body = await (await GET()).json();
    for (const tool of ["claude", "codex", "opencode", "droid", "openclaw", "hermes", "cowork", "copilot", "deepseek-tui", "jcode", "grok-build"]) {
      expect(body[tool], tool).toBeTruthy();
    }
    expectNoSecrets(body);
  });

  it("claude: base URL, model mappings and context cap, but no foreign token or other env", async () => {
    const body = await status("claude-settings");
    expectNoSecrets(body);
    expect(body.settings.env).toEqual({
      ANTHROPIC_BASE_URL: "http://localhost:20128/v1",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "cc/opus-placeholder",
      CLAUDE_CODE_MAX_CONTEXT_TOKENS: "200000",
    });
    expect(body.has10Router).toBe(true);
  });

  it("claude: returns the token when it is one of this instance's client keys", async () => {
    write(".claude/settings.json", { env: { ANTHROPIC_BASE_URL: "http://localhost:20128/v1", ANTHROPIC_AUTH_TOKEN: OWN_KEY } });
    const body = await status("claude-settings");
    expect(body.settings.env.ANTHROPIC_AUTH_TOKEN).toBe(OWN_KEY);
  });

  it("opencode: base URL and explorer model, no provider keys", async () => {
    const body = await status("opencode-settings");
    expectNoSecrets(body);
    expect(body.config.provider["10router"].options.baseURL).toBe("http://localhost:20128/v1");
    expect(body.config.agent.explorer.model).toBe("10router/m2");
    expect(body.opencode).toEqual({ models: ["m1"], activeModel: "m1", baseURL: "http://localhost:20128/v1" });
  });

  it("codex: model, subagent model and base URL, not the raw config.toml", async () => {
    const body = await status("codex-settings");
    expectNoSecrets(body);
    expect(body).not.toHaveProperty("config");
    expect(body.hasConfig).toBe(true);
    expect(body.codex).toEqual({
      model: "cx/model-placeholder",
      subagentModel: "cx/sub-placeholder",
      baseUrl: "http://localhost:20128/v1",
    });
    expect(body.has10Router).toBe(true);
  });

  it("droid: only this router's custom models, without their keys", async () => {
    const body = await status("droid-settings");
    expectNoSecrets(body);
    expect(body.settings.customModels).toEqual([
      { id: "custom:10router-0", index: 0, model: "m1", baseUrl: "http://localhost:20128/v1" },
    ]);
  });

  it("openclaw: this router's provider (with its own client key) and the default model", async () => {
    const body = await status("openclaw-settings");
    expectNoSecrets(body);
    expect(body.settings.models.providers).toEqual({ "10router": { baseUrl: "http://localhost:20128/v1", apiKey: OWN_KEY } });
    expect(body.settings.agents.defaults.model.primary).toBe("10router/m1");
    expect(body.agents).toEqual([{ id: "a1", name: "A1", model: "", currentModel: null }]);
  });

  it("copilot, hermes, deepseek-tui, jcode, grok-build and cowork keep the fields their cards read", async () => {
    const copilot = await status("copilot-settings");
    expect(copilot.config).toEqual([{ name: "10router", models: [{ id: "m1", url: "http://localhost:20128/v1/chat/completions" }] }]);
    const hermes = await status("hermes-settings");
    expect(hermes.settings.model).toEqual({ default: "m1", provider: "custom", base_url: "http://localhost:20128/v1" });
    const deepseek = await status("deepseek-tui-settings");
    expect(deepseek.settings).toEqual({ provider: "openai", "providers.openai": { base_url: "http://localhost:20128/v1", model: "m1" } });
    const jcode = await status("jcode-settings");
    expect(jcode.config).toEqual({ providers: { "10router": { base_url: "http://localhost:20128/v1", default_model: "m1" } } });
    const grok = await status("grok-build-settings");
    expect(grok.settings.model).toEqual(expect.objectContaining({ model: "m1", base_url: "http://localhost:20128/v1" }));
    expect(grok.settings.model).not.toHaveProperty("api_key");
    expect(grok.settings.model).not.toHaveProperty("raw");
    const cowork = await status("cowork-settings");
    expect(cowork).not.toHaveProperty("config");
    expect(cowork.cowork.baseUrl).toBe("http://localhost:20128/v1");
    for (const body of [copilot, hermes, deepseek, jcode, grok, cowork]) expectNoSecrets(body);
  });
});

describe("Cowork applied config is owner-only", () => {
  it("writes the config holding the client key and CLI token with mode 0600, and tightens an existing one", async () => {
    if (process.platform === "win32") return;
    const previousUmask = process.umask(0o022);
    try {
      const { POST } = await import("../../src/app/api/cli-tools/cowork-settings/route.js");
      const configFile = path.join(home, ".config", "Claude-3p", "configLibrary", "cfg.json");
      fs.chmodSync(configFile, 0o644);
      const res = await POST(new Request("http://localhost/x", {
        method: "POST",
        body: JSON.stringify({ baseUrl: "http://localhost:20128/v1", apiKey: OWN_KEY, models: ["m1"], plugins: [], localPlugins: [] }),
      }));
      expect(res.status).toBe(200);
      expect(fs.readFileSync(configFile, "utf8")).toContain(OWN_KEY);
      expect(fs.statSync(configFile).mode & 0o777).toBe(0o600);

      // A fresh install: no applied config yet.
      fs.rmSync(path.join(home, ".config", "Claude-3p"), { recursive: true, force: true });
      const fresh = await POST(new Request("http://localhost/x", {
        method: "POST",
        body: JSON.stringify({ baseUrl: "http://localhost:20128/v1", apiKey: OWN_KEY, models: ["m1"], plugins: [], localPlugins: [] }),
      }));
      const { configPath } = await fresh.json();
      expect(fs.statSync(configPath).mode & 0o777).toBe(0o600);
    } finally {
      process.umask(previousUmask);
    }
  });
});
