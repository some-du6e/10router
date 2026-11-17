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
  "sk-placeholder-plugin-key",
  "sk-placeholder-custom-plugin-key",
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
        "10router": { baseUrl: "http://localhost:20128/v1", apiKey: OWN_KEY, models: [{ id: "m1", name: "m1" }] },
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
      { name: "exa", url: "https://mcp.exa.example/mcp?exaApiKey=sk-placeholder-plugin-key&mode=fast", transport: "http" },
      { name: "mine", url: "https://mcp.example.com/sse?tavilyApiKey=sk-placeholder-custom-plugin-key", transport: "sse", custom: true },
    ],
  });

  // Grok Build: written through its own route, which stores the key in the section.
  const { POST } = await import("../../src/app/api/cli-tools/grok-build-settings/route.js");
  await POST(new Request("http://localhost/x", {
    method: "POST",
    body: JSON.stringify({
      baseUrl: "http://localhost:20128",
      apiKey: "sk-placeholder-grok-key",
      model: "m1",
      subagentModels: { explore: { model: "m2" } },
    }),
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
    // Loads every tool route (and each one's `which` probe) on first import.
  }, 30000);

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

  it("claude: says a foreign token is set without returning it", async () => {
    const body = await status("claude-settings");
    expect(body.authToken).toEqual({ set: true, ownKeyId: null });
  });

  it("claude: names one of this instance's keys by id, never by value", async () => {
    write(".claude/settings.json", { env: { ANTHROPIC_BASE_URL: "http://localhost:20128/v1", ANTHROPIC_AUTH_TOKEN: OWN_KEY } });
    const body = await status("claude-settings");
    expect(body.authToken).toEqual({ set: true, ownKeyId: "k1" });
    expect(JSON.stringify(body)).not.toContain(OWN_KEY);
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
    expect(body.hasConfig).toBe(true);
    // Published CLI launchers regex these two lines out of `config`.
    expect(body.config).toBe('model = "cx/model-placeholder"\n[model_providers.10router]\nbase_url = "http://localhost:20128/v1"\n');
    expect(body.config.match(/base_url\s*=\s*"([^"]+)"/)[1]).toBe("http://localhost:20128/v1");
    expect(body.config.match(/^model\s*=\s*"([^"]+)"/m)[1]).toBe("cx/model-placeholder");
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

  it("openclaw: this router's provider (key status, first model) and the default model", async () => {
    const body = await status("openclaw-settings");
    expectNoSecrets(body);
    expect(JSON.stringify(body)).not.toContain(OWN_KEY);
    expect(body.settings.models.providers).toEqual({
      "10router": { baseUrl: "http://localhost:20128/v1", models: [{ id: "m1" }], apiKeyStatus: { set: true, ownKeyId: "k1" } },
    });
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
    expect(grok.settings.subagentModels.explore).toEqual(expect.objectContaining({ model: "m2" }));
    expect(grok.settings.subagentModels.explore).not.toHaveProperty("api_key");
    const cowork = await status("cowork-settings");
    expect(cowork).not.toHaveProperty("config");
    expect(cowork.cowork.baseUrl).toBe("http://localhost:20128/v1");
    expect(cowork.cowork.plugins.find((p) => p.name === "exa").url).toBe("https://mcp.exa.example/mcp?exaApiKey=[REDACTED]&mode=fast");
    expect(cowork.cowork.customPlugins.find((p) => p.name === "mine").url).toBe("https://mcp.example.com/sse?tavilyApiKey=[REDACTED]");
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

const post = async (route, body) => {
  const { POST } = await import(`../../src/app/api/cli-tools/${route}/route.js`);
  return POST(new Request("http://localhost/x", { method: "POST", body: JSON.stringify(body) }));
};
const readJsonFile = (rel) => JSON.parse(fs.readFileSync(path.join(home, rel), "utf8"));

describe("a key the status can't show is kept on Apply", () => {
  it("claude: KEEP_EXISTING_KEY leaves a custom token in settings.json", async () => {
    const { KEEP_EXISTING_KEY } = await import("../../src/lib/cliTools/keepKey.js");
    write(".claude/settings.json", { env: { ANTHROPIC_BASE_URL: "https://other.example.com/v1", ANTHROPIC_AUTH_TOKEN: "sk-placeholder-foreign-key" } });
    const res = await post("claude-settings", { env: { ANTHROPIC_BASE_URL: "http://localhost:20128/v1", ANTHROPIC_AUTH_TOKEN: KEEP_EXISTING_KEY } });
    expect(res.status).toBe(200);
    const env = readJsonFile(".claude/settings.json").env;
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("sk-placeholder-foreign-key");
    expect(env.ANTHROPIC_BASE_URL).toBe("http://localhost:20128/v1");
    expect(JSON.stringify(await status("claude-settings"))).not.toContain("sk-placeholder-foreign-key");
  });

  it("openclaw: KEEP_EXISTING_KEY leaves a custom provider key in openclaw.json", async () => {
    const { KEEP_EXISTING_KEY } = await import("../../src/lib/cliTools/keepKey.js");
    write(".openclaw/openclaw.json", { models: { providers: { "10router": { baseUrl: "https://other.example.com/v1", apiKey: "sk-placeholder-foreign-key" } } } });
    const before = await status("openclaw-settings");
    expect(before.settings.models.providers["10router"].apiKeyStatus).toEqual({ set: true, ownKeyId: null });
    expectNoSecrets(before);
    const res = await post("openclaw-settings", { baseUrl: "http://localhost:20128", apiKey: KEEP_EXISTING_KEY, model: "m1" });
    expect(res.status).toBe(200);
    expect(readJsonFile(".openclaw/openclaw.json").models.providers["10router"].apiKey).toBe("sk-placeholder-foreign-key");
  });

  it("openclaw: KEEP_EXISTING_KEY with no stored key is refused, never written", async () => {
    const { KEEP_EXISTING_KEY } = await import("../../src/lib/cliTools/keepKey.js");
    write(".openclaw/openclaw.json", {});
    const res = await post("openclaw-settings", { baseUrl: "http://localhost:20128", apiKey: KEEP_EXISTING_KEY, model: "m1" });
    expect(res.status).toBe(400);
    expect(fs.readFileSync(path.join(home, ".openclaw/openclaw.json"), "utf8")).not.toContain(KEEP_EXISTING_KEY);
  });

  it("jcode: the env-file key is reported by status only and kept by KEEP_EXISTING_KEY", async () => {
    const { KEEP_EXISTING_KEY } = await import("../../src/lib/cliTools/keepKey.js");
    write(".config/jcode/provider-10router.env", 'JCODE_10ROUTER_API_KEY="sk-placeholder-foreign-key"\n');
    const before = await status("jcode-settings");
    expect(before.apiKeyStatus).toEqual({ set: true, ownKeyId: null });
    expectNoSecrets(before);
    const res = await post("jcode-settings", { baseUrl: "http://localhost:20128", apiKey: KEEP_EXISTING_KEY, models: ["m1"] });
    expect(res.status).toBe(200);
    const envFile = path.join(home, ".config/jcode/provider-10router.env");
    expect(fs.readFileSync(envFile, "utf8")).toContain('JCODE_10ROUTER_API_KEY="sk-placeholder-foreign-key"');
    expect(fs.readFileSync(envFile, "utf8")).not.toContain(KEEP_EXISTING_KEY);
  });
});

describe("Cowork plugin URLs", () => {
  it("a re-apply with the redacted URL the status showed keeps the stored key", async () => {
    write(".config/Claude-3p/configLibrary/_meta.json", { appliedId: "cfg" });
    write(".config/Claude-3p/configLibrary/cfg.json", {
      inferenceProvider: "gateway",
      inferenceGatewayBaseUrl: "http://localhost:20128/v1",
      managedMcpServers: [{ name: "exa", url: "https://mcp.exa.example/mcp?exaApiKey=sk-placeholder-plugin-key", transport: "http" }],
    });
    const shown = await status("cowork-settings");
    const plugins = shown.cowork.plugins;
    expect(plugins[0].url).toBe("https://mcp.exa.example/mcp?exaApiKey=[REDACTED]");
    const res = await post("cowork-settings", { baseUrl: "http://localhost:20128/v1", apiKey: OWN_KEY, models: ["m1"], plugins, localPlugins: [] });
    const { configPath } = await res.json();
    const written = JSON.parse(fs.readFileSync(configPath, "utf8"));
    expect(written.managedMcpServers.find((m) => m.name === "exa").url).toBe("https://mcp.exa.example/mcp?exaApiKey=sk-placeholder-plugin-key");
  });
});

describe.runIf(process.platform !== "win32")("tool config files holding a client key are owner-only", () => {
  const modeOf = (rel) => fs.statSync(path.join(home, rel)).mode & 0o777;
  let previousUmask;
  beforeAll(() => {
    previousUmask = process.umask(0o022);
  });
  afterAll(() => process.umask(previousUmask));

  it.each([
    ["cline-settings", ".cline/data/secrets.json", { baseUrl: "http://localhost:20128/v1", apiKey: OWN_KEY, model: "m1" }],
    ["kilo-settings", ".local/share/kilo/auth.json", { baseUrl: "http://localhost:20128/v1", apiKey: OWN_KEY, model: "m1" }],
    ["claude-settings", ".claude/settings.json", { env: { ANTHROPIC_BASE_URL: "http://localhost:20128/v1", ANTHROPIC_AUTH_TOKEN: OWN_KEY } }],
    ["jcode-settings", ".config/jcode/provider-10router.env", { baseUrl: "http://localhost:20128", apiKey: OWN_KEY, models: ["m1"] }],
  ])("%s writes %s 0600, replacing a world-readable one", async (route, rel, body) => {
    write(rel, rel.endsWith(".env") ? "OTHER=1\n" : "{}");
    fs.chmodSync(path.join(home, rel), 0o644);
    const res = await post(route, body);
    expect(res.status).toBe(200);
    expect(fs.readFileSync(path.join(home, rel), "utf8")).toContain(OWN_KEY);
    expect(modeOf(rel)).toBe(0o600);
    // Nothing left behind next to it.
    expect(fs.readdirSync(path.dirname(path.join(home, rel))).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("writes through a symlinked config to the file it points at", async () => {
    const real = path.join(home, "dotfiles", "secrets.json");
    fs.mkdirSync(path.dirname(real), { recursive: true });
    fs.writeFileSync(real, "{}");
    const link = path.join(home, ".cline/data/secrets.json");
    fs.rmSync(link, { force: true });
    fs.symlinkSync(real, link);
    const res = await post("cline-settings", { baseUrl: "http://localhost:20128/v1", apiKey: OWN_KEY, model: "m1" });
    expect(res.status).toBe(200);
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(real, "utf8")).toContain(OWN_KEY);
    expect(fs.statSync(real).mode & 0o777).toBe(0o600);
  });
});
