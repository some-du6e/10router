import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { parseTOML } from "confbox";

// A CLI tool settings route writes a base URL the request picked. If the tool
// then keeps using a credential already on this host (Codex's own login, the
// OPENAI_API_KEY in Hermes' .env, Claude Code's own login, stored headers), a
// dashboard session could have that credential sent to any host. For a base URL
// that is neither the stored one nor this instance, the request has to bring the
// key and the route has to write it where the tool uses it; otherwise 400.

// Every route resolves files under os.homedir(): pin it to a temp dir.
const fakeHome = vi.hoisted(() => ({ dir: null }));
vi.mock("os", async (importOriginal) => {
  const actual = await importOriginal();
  const homedir = () => {
    if (!fakeHome.dir) throw new Error("foreign-base-url test: home not set");
    return fakeHome.dir;
  };
  return { ...actual, homedir, default: { ...(actual.default ?? actual), homedir } };
});

// No installed tools to ask: `which` and the like fail. `codex --version` answers
// codex.version (null: not installed).
const codex = vi.hoisted(() => ({ version: "codex-cli 0.169.0" }));
vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal();
  const { promisify: p } = await import("node:util");
  const run = async (command) => {
    if (command === "codex --version" && codex.version !== null) return { stdout: `${codex.version}\n`, stderr: "" };
    throw new Error("command not found");
  };
  const exec = (command, options, callback) => {
    const done = typeof options === "function" ? options : callback;
    run(command).then(({ stdout, stderr }) => done(null, stdout, stderr), (error) => done(error));
  };
  exec[p.custom] = run;
  return { ...actual, exec, default: { ...(actual.default ?? actual), exec } };
});

// Codex's catalog decision reads the router's database; not what this is about.
vi.mock("@/lib/codex/catalogUrlDecision.js", () => ({
  decideCatalogUrl: vi.fn(async () => ({ write: false, reason: "codex-version" })),
}));
vi.mock("@/lib/tunnel/cloudflare/manager.js", () => ({
  getTunnelStatus: vi.fn(async () => ({ settingsEnabled: false, publicUrl: "", tunnelUrl: "" })),
}));
vi.mock("@/lib/localDb", () => ({
  getApiKeys: vi.fn(async () => []),
  getSettings: vi.fn(async () => ({})),
}));

const home = fs.mkdtempSync(path.join(os.tmpdir(), "10r-foreign-base-"));
fakeHome.dir = home;
const originalEnv = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, XDG: process.env.XDG_CONFIG_HOME };
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.XDG_CONFIG_HOME = path.join(home, ".config");

const routeHome = (await import("os")).homedir();
if (routeHome !== home) throw new Error(`foreign-base-url test: os.homedir() is ${routeHome}, not the temp dir; refusing to write tool configs`);

afterAll(() => {
  for (const [key, value] of [["HOME", originalEnv.HOME], ["USERPROFILE", originalEnv.USERPROFILE], ["XDG_CONFIG_HOME", originalEnv.XDG]]) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(home, { recursive: true, force: true });
});

const FOREIGN = "https://attacker.example.net";
const OWN = "http://127.0.0.1:20128";
const USER_KEY = "sk-placeholder-user-key";
const NEW_KEY = "sk-placeholder-request-key";
const OTHER_KEY = "sk-placeholder-second-key";

const file = (rel) => path.join(home, rel);
const write = (rel, content) => {
  fs.mkdirSync(path.dirname(file(rel)), { recursive: true });
  fs.writeFileSync(file(rel), typeof content === "string" ? content : JSON.stringify(content, null, 2));
};
const read = (rel) => fs.readFileSync(file(rel), "utf8");
const readJson = (rel) => JSON.parse(read(rel));
const mode = (rel) => fs.statSync(file(rel)).mode & 0o777;
const post = async (route, body) => {
  const { POST } = await import(`../../src/app/api/cli-tools/${route}/route.js`);
  return POST(new Request("http://localhost/x", { method: "POST", body: JSON.stringify(body) }));
};

beforeEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.mkdirSync(home, { recursive: true });
  codex.version = "codex-cli 0.169.0";
});

describe("codex: a foreign base URL never gets Codex's own login", () => {
  const CONFIG = ".codex/config.toml";
  const EXISTING = [
    'model = "cx/model-placeholder"',
    'model_provider = "10router"',
    "",
    "[model_providers.10router]",
    'name = "openai"',
    `base_url = "${OWN}/backend-api/codex"`,
    'wire_api = "responses"',
    "requires_openai_auth = true",
    "",
  ].join("\n");
  const provider = () => parseTOML(read(CONFIG)).model_providers["10router"];
  const OWN_NATIVE = { name: "openai", base_url: `${OWN}/backend-api/codex`, wire_api: "responses", requires_openai_auth: true };

  it.each([[true], [false]])("native=%s without a usable key: 400, config.toml untouched", async (native) => {
    write(CONFIG, EXISTING);
    const res = await post("codex-settings", { baseUrl: FOREIGN, apiKey: "   ", model: "m1", native });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe(
      "Codex would send its own login (~/.codex/auth.json) to https://attacker.example.net, which isn't this 10router; choose a key for it"
    );
    expect(read(CONFIG)).toBe(EXISTING);
  });

  it("native, with a key: the section carries that key and doesn't ask for Codex's login", async () => {
    write(CONFIG, EXISTING);
    const res = await post("codex-settings", { baseUrl: FOREIGN, apiKey: NEW_KEY, model: "m1" });
    expect(res.status).toBe(200);
    expect(provider()).toEqual({
      name: "openai",
      base_url: `${FOREIGN}/backend-api/codex`,
      wire_api: "responses",
      experimental_bearer_token: NEW_KEY,
    });
    expect(mode(CONFIG)).toBe(0o600);
  });

  it("OpenAI-compatible, with a key: the section carries that key", async () => {
    const res = await post("codex-settings", { baseUrl: FOREIGN, apiKey: NEW_KEY, model: "m1", native: false });
    expect(res.status).toBe(200);
    expect(provider()).toEqual({ name: "10router", base_url: `${FOREIGN}/v1`, wire_api: "responses", experimental_bearer_token: NEW_KEY });
  });

  it.each([
    ["0.47.0, which predates experimental_bearer_token", "codex-cli 0.47.0", "Codex 0.47.0"],
    ["an unknown version", null, "The installed Codex (version unknown)"],
    ["a version it can't parse", "codex-cli dev", "The installed Codex (version unknown)"],
    ["a source build (0.0.0)", "codex-cli 0.0.0", "Codex 0.0.0"],
  ])("a foreign host with Codex %s: 400, config.toml untouched", async (_label, version, named) => {
    codex.version = version;
    write(CONFIG, EXISTING);
    const res = await post("codex-settings", { baseUrl: FOREIGN, apiKey: NEW_KEY, model: "m1" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe(
      `${named} would send its own login (~/.codex/auth.json) to a host that isn't this 10router; update Codex to 0.48.0 or newer to use a non-10router base URL from the dashboard`
    );
    expect(read(CONFIG)).toBe(EXISTING);
  });

  it("Codex 0.48.0 takes a foreign host's key; an older or unreadable Codex still points at this instance as before", async () => {
    codex.version = "codex-cli 0.48.0";
    expect((await post("codex-settings", { baseUrl: FOREIGN, apiKey: NEW_KEY, model: "m1" })).status).toBe(200);
    expect(provider().experimental_bearer_token).toBe(NEW_KEY);
    for (const version of ["codex-cli 0.47.0", null]) {
      codex.version = version;
      expect((await post("codex-settings", { baseUrl: OWN, apiKey: NEW_KEY, model: "m1" })).status).toBe(200);
      expect(provider()).toEqual(OWN_NATIVE);
    }
  });

  it("re-applying the same foreign base URL needs a key again, and a different key replaces the token", async () => {
    await post("codex-settings", { baseUrl: FOREIGN, apiKey: NEW_KEY, model: "m1" });
    const refused = await post("codex-settings", { baseUrl: FOREIGN, apiKey: " ", model: "m1" });
    expect(refused.status).toBe(400);
    const again = await post("codex-settings", { baseUrl: FOREIGN, apiKey: OTHER_KEY, model: "m2" });
    expect(again.status).toBe(200);
    expect(provider().experimental_bearer_token).toBe(OTHER_KEY);
    expect(read(CONFIG)).not.toContain(NEW_KEY);
  });

  it("a foreign host, then this instance: the token goes and Codex's own login comes back", async () => {
    await post("codex-settings", { baseUrl: FOREIGN, apiKey: NEW_KEY, model: "m1" });
    expect((await post("codex-settings", { baseUrl: OWN, apiKey: NEW_KEY, model: "m1" })).status).toBe(200);
    expect(provider()).toEqual(OWN_NATIVE);
    expect(read(CONFIG)).not.toContain(NEW_KEY);
  });

  it("this instance: unchanged, Codex's own login and no key in config.toml", async () => {
    const res = await post("codex-settings", { baseUrl: OWN, apiKey: NEW_KEY, model: "m1" });
    expect(res.status).toBe(200);
    expect(provider()).toEqual(OWN_NATIVE);
    expect(read(CONFIG)).not.toContain(NEW_KEY);
    await post("codex-settings", { baseUrl: "http://localhost:20128", apiKey: NEW_KEY, model: "m1", native: false });
    expect(provider()).toEqual({ name: "10router", base_url: "http://localhost:20128/v1", wire_api: "responses" });
  });
});

describe("hermes: a foreign base URL never gets the OPENAI_API_KEY in ~/.hermes/.env", () => {
  const CONFIG = ".hermes/config.yaml";
  const ENV = ".hermes/.env";
  const block = (baseUrl, apiKey) => `model:\n  default: "m0"\n  provider: "custom"\n  base_url: "${baseUrl}"\n  api_key: ${apiKey}\n`;
  const REF = "${OPENAI_API_KEY}";

  beforeEach(() => {
    write(CONFIG, `${block(`${OWN}/v1`, REF)}\nother: kept\n`);
    write(ENV, `OPENAI_API_KEY=${USER_KEY}\n`);
  });

  it.each([["no key", {}], ["an empty key", { apiKey: "" }], ["a blank key", { apiKey: "  " }]])(
    "with %s: 400, config.yaml and .env untouched",
    async (_label, key) => {
      const before = read(CONFIG);
      const res = await post("hermes-settings", { baseUrl: FOREIGN, model: "m1", ...key });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe(
        "Hermes would send OPENAI_API_KEY from ~/.hermes/.env to https://attacker.example.net, which is neither its current base URL nor this 10router; choose a key for it"
      );
      expect(read(CONFIG)).toBe(before);
      expect(read(ENV)).toBe(`OPENAI_API_KEY=${USER_KEY}\n`);
    }
  );

  it("with a key: the block carries that key, and the user's .env key stays as it was", async () => {
    const res = await post("hermes-settings", { baseUrl: FOREIGN, apiKey: NEW_KEY, model: "m1" });
    expect(res.status).toBe(200);
    const yaml = read(CONFIG);
    expect(yaml).toContain(`base_url: "${FOREIGN}/v1"`);
    expect(yaml).toContain(`api_key: "${NEW_KEY}"`);
    expect(yaml).not.toContain(REF);
    expect(yaml).toContain("other: kept");
    expect(mode(CONFIG)).toBe(0o600);
    expect(read(ENV)).toBe(`OPENAI_API_KEY=${USER_KEY}\n`);
  });

  it("the stored base URL keeps the .env key only when the stored block already sent it there", async () => {
    write(CONFIG, block(`${FOREIGN}/v1`, REF));
    expect((await post("hermes-settings", { baseUrl: FOREIGN, model: "m1" })).status).toBe(200);
    expect(read(CONFIG)).toContain(`api_key: ${REF}`);

    // A block with a key of its own never sent the .env key anywhere.
    write(CONFIG, block(`${FOREIGN}/v1`, `"${NEW_KEY}"`));
    const res = await post("hermes-settings", { baseUrl: FOREIGN, model: "m1" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe(
      "Hermes would send OPENAI_API_KEY from ~/.hermes/.env to https://attacker.example.net, which isn't this 10router; choose a key for it"
    );
    expect(read(CONFIG)).toContain(`api_key: "${NEW_KEY}"`);
  });

  it("a foreign host, then this instance: the block's key goes and ${OPENAI_API_KEY} comes back", async () => {
    await post("hermes-settings", { baseUrl: FOREIGN, apiKey: NEW_KEY, model: "m1" });
    expect((await post("hermes-settings", { baseUrl: OWN, model: "m1" })).status).toBe(200);
    const yaml = read(CONFIG);
    expect(yaml).toContain(`api_key: ${REF}`);
    expect(yaml).not.toContain(NEW_KEY);
    expect(read(ENV)).toBe(`OPENAI_API_KEY=${USER_KEY}\n`);
  });

  it("this instance: unchanged, the block reads .env and a sent key goes there", async () => {
    expect((await post("hermes-settings", { baseUrl: OWN, model: "m1" })).status).toBe(200);
    expect(read(CONFIG)).toContain(`api_key: ${REF}`);
    expect(read(ENV)).toBe(`OPENAI_API_KEY=${USER_KEY}\n`);
    expect((await post("hermes-settings", { baseUrl: "http://localhost:20128", apiKey: NEW_KEY, model: "m1" })).status).toBe(200);
    expect(read(CONFIG)).toContain(`api_key: ${REF}`);
    expect(read(ENV)).toBe(`OPENAI_API_KEY=${NEW_KEY}\n`);
  });
});

describe("claude: a foreign base URL never gets Claude Code's own login or the stored token", () => {
  const SETTINGS = ".claude/settings.json";
  const STORED = { env: { ANTHROPIC_BASE_URL: `${OWN}/v1` } };

  beforeEach(() => {
    write(SETTINGS, STORED);
  });

  it.each([["a blank token", "   "], ["a numeric token", 12345]])("%s is refused for any base URL, settings.json untouched", async (_label, token) => {
    for (const env of [{ ANTHROPIC_BASE_URL: FOREIGN, ANTHROPIC_AUTH_TOKEN: token }, { ANTHROPIC_BASE_URL: OWN, ANTHROPIC_AUTH_TOKEN: token }, { ANTHROPIC_AUTH_TOKEN: token }]) {
      const res = await post("claude-settings", { env });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("ANTHROPIC_AUTH_TOKEN must be a non-blank string; choose a key");
      expect(readJson(SETTINGS)).toEqual(STORED);
    }
  });

  it.each([["a blank token", "   "], ["a numeric token", 12345]])(
    "two steps: a foreign URL with a throwaway token, then %s without a URL, is refused",
    async (_label, token) => {
      expect((await post("claude-settings", { env: { ANTHROPIC_BASE_URL: FOREIGN, ANTHROPIC_AUTH_TOKEN: NEW_KEY } })).status).toBe(200);
      const res = await post("claude-settings", { env: { ANTHROPIC_AUTH_TOKEN: token } });
      expect(res.status).toBe(400);
      expect(readJson(SETTINGS).env.ANTHROPIC_AUTH_TOKEN).toBe(NEW_KEY);
    }
  );

  it("names what would go: its own login with no stored token, the stored token otherwise", async () => {
    const noToken = await post("claude-settings", { env: { ANTHROPIC_BASE_URL: FOREIGN } });
    expect(noToken.status).toBe(400);
    expect((await noToken.json()).error).toBe(
      "Claude Code would send its own Claude login to https://attacker.example.net, which is neither its current base URL nor this 10router; choose a key for it"
    );
    write(SETTINGS, { env: { ANTHROPIC_BASE_URL: `${OWN}/v1`, ANTHROPIC_AUTH_TOKEN: USER_KEY } });
    const stored = await post("claude-settings", { env: { ANTHROPIC_BASE_URL: FOREIGN } });
    expect(stored.status).toBe(400);
    expect((await stored.json()).error).toBe(
      "Claude Code would send the stored ANTHROPIC_AUTH_TOKEN to https://attacker.example.net, which is neither its current base URL nor this 10router; choose a key for it"
    );
    expect(readJson(SETTINGS).env.ANTHROPIC_BASE_URL).toBe(`${OWN}/v1`);
  });

  it("a base URL that isn't a string is a 400, not a 500", async () => {
    const res = await post("claude-settings", { env: { ANTHROPIC_BASE_URL: 8080 } });
    expect(res.status).toBe(400);
    expect(readJson(SETTINGS)).toEqual(STORED);
  });

  it("with a token: written, so Claude Code sends it instead of its login", async () => {
    const res = await post("claude-settings", { env: { ANTHROPIC_BASE_URL: FOREIGN, ANTHROPIC_AUTH_TOKEN: NEW_KEY } });
    expect(res.status).toBe(200);
    expect(readJson(SETTINGS).env).toMatchObject({ ANTHROPIC_BASE_URL: `${FOREIGN}/v1`, ANTHROPIC_AUTH_TOKEN: NEW_KEY });
    // Its stored base URL now: a model change without a token is fine.
    expect((await post("claude-settings", { env: { ANTHROPIC_DEFAULT_OPUS_MODEL: "cc/opus-placeholder" } })).status).toBe(200);
    expect(readJson(SETTINGS).env.ANTHROPIC_AUTH_TOKEN).toBe(NEW_KEY);
  });

  it("this instance: unchanged, no token needed", async () => {
    const res = await post("claude-settings", { env: { ANTHROPIC_BASE_URL: "http://localhost:20128" } });
    expect(res.status).toBe(200);
    expect(readJson(SETTINGS).env.ANTHROPIC_BASE_URL).toBe("http://localhost:20128/v1");
  });
});

describe("opencode: stored provider headers and query params never follow a foreign base URL", () => {
  const CONFIG = ".config/opencode/opencode.json";
  const stored = ({ baseURL = `${OWN}/v1`, options = {}, models = {} } = {}) => ({
    provider: { "10router": { npm: "@ai-sdk/openai-compatible", options: { baseURL, apiKey: USER_KEY, ...options }, models } },
  });
  const HEADERS = { Authorization: "Bearer sk-placeholder-header-token" };

  it.each([
    ["options.headers", stored({ options: { headers: HEADERS } }), "provider.10router.options.headers"],
    ["options.queryParams", stored({ options: { queryParams: { key: "sk-placeholder-query-key" } } }), "provider.10router.options.queryParams"],
    ["a kept model's headers", stored({ models: { old: { name: "old", headers: HEADERS } } }), "provider.10router.models.old.headers"],
  ])("stored %s: 400 naming it, opencode.json untouched", async (_label, config, name) => {
    write(CONFIG, config);
    const before = read(CONFIG);
    const res = await post("opencode-settings", { baseUrl: FOREIGN, apiKey: NEW_KEY, models: ["m1"] });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe(`opencode.json has ${name}; remove it or point OpenCode back at this instance`);
    expect(read(CONFIG)).toBe(before);
  });

  it("a model the request replaces doesn't keep its headers, so they don't count", async () => {
    write(CONFIG, stored({ models: { m1: { name: "m1", headers: HEADERS } } }));
    const res = await post("opencode-settings", { baseUrl: FOREIGN, apiKey: NEW_KEY, models: ["m1"] });
    expect(res.status).toBe(200);
    expect(readJson(CONFIG).provider["10router"].models.m1.headers).toBeUndefined();
  });

  it("no stored headers: the request's key is written with the base URL", async () => {
    write(CONFIG, stored());
    const res = await post("opencode-settings", { baseUrl: FOREIGN, apiKey: NEW_KEY, models: ["m1"] });
    expect(res.status).toBe(200);
    expect(readJson(CONFIG).provider["10router"].options).toEqual({ baseURL: `${FOREIGN}/v1`, apiKey: NEW_KEY });
  });

  it("the same stored base URL keeps its headers", async () => {
    write(CONFIG, stored({ baseURL: `${FOREIGN}/v1`, options: { headers: HEADERS } }));
    const res = await post("opencode-settings", { baseUrl: FOREIGN, apiKey: NEW_KEY, models: ["m1"] });
    expect(res.status).toBe(200);
    expect(readJson(CONFIG).provider["10router"].options.headers).toEqual(HEADERS);
  });

  it("this instance: unchanged, stored headers stay", async () => {
    write(CONFIG, stored({ options: { headers: { "x-placeholder": "1" } } }));
    const res = await post("opencode-settings", { baseUrl: "http://localhost:20128", apiKey: NEW_KEY, models: ["m1"] });
    expect(res.status).toBe(200);
    expect(readJson(CONFIG).provider["10router"].options).toEqual({ baseURL: "http://localhost:20128/v1", apiKey: NEW_KEY, headers: { "x-placeholder": "1" } });
  });

  it.each([[8080], [["https://a.example.com"]], [{ url: FOREIGN }]])("a base URL that is %j is a 400, not a 500", async (baseUrl) => {
    write(CONFIG, stored());
    const before = read(CONFIG);
    const res = await post("opencode-settings", { baseUrl, apiKey: NEW_KEY, models: ["m1"] });
    expect(res.status).toBe(400);
    expect(read(CONFIG)).toBe(before);
  });
});

describe("cline: stored openAiHeaders never follow a foreign base URL", () => {
  const STATE = ".cline/data/globalState.json";
  const SECRETS = ".cline/data/secrets.json";
  const HEADERS = { Authorization: "Bearer sk-placeholder-header-token" };

  it("stored headers: 400 naming them, both files byte-for-byte untouched", async () => {
    write(STATE, { openAiBaseUrl: OWN, openAiHeaders: HEADERS });
    write(SECRETS, { openAiApiKey: USER_KEY });
    const before = { state: read(STATE), secrets: read(SECRETS) };
    const res = await post("cline-settings", { baseUrl: FOREIGN, apiKey: NEW_KEY, model: "m1" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("globalState.json has openAiHeaders; remove it or point Cline back at this instance");
    expect(read(STATE)).toBe(before.state);
    expect(read(SECRETS)).toBe(before.secrets);
  });

  it("no stored headers: the request's key is written with the base URL", async () => {
    write(STATE, { openAiBaseUrl: OWN, openAiHeaders: {} });
    const res = await post("cline-settings", { baseUrl: FOREIGN, apiKey: NEW_KEY, model: "m1" });
    expect(res.status).toBe(200);
    expect(readJson(STATE).openAiBaseUrl).toBe(FOREIGN);
    expect(readJson(SECRETS)).toEqual({ openAiApiKey: NEW_KEY });
  });

  it("the same stored base URL keeps its headers", async () => {
    write(STATE, { openAiBaseUrl: FOREIGN, openAiHeaders: HEADERS });
    const res = await post("cline-settings", { baseUrl: `${FOREIGN}/v1`, apiKey: NEW_KEY, model: "m1" });
    expect(res.status).toBe(200);
    expect(readJson(STATE)).toMatchObject({ openAiBaseUrl: FOREIGN, openAiHeaders: HEADERS });
  });

  it("this instance: unchanged, stored headers stay", async () => {
    write(STATE, { openAiBaseUrl: FOREIGN, openAiHeaders: { "x-placeholder": "1" } });
    const res = await post("cline-settings", { baseUrl: `${OWN}/v1`, apiKey: NEW_KEY, model: "m1" });
    expect(res.status).toBe(200);
    expect(readJson(STATE)).toMatchObject({ openAiBaseUrl: OWN, openAiHeaders: { "x-placeholder": "1" } });
  });

  it.each([[8080], [["https://a.example.com"]], [{ url: FOREIGN }]])("a base URL that is %j is a 400, not a 500", async (baseUrl) => {
    write(STATE, { openAiBaseUrl: OWN });
    const before = read(STATE);
    const res = await post("cline-settings", { baseUrl, apiKey: NEW_KEY, model: "m1" });
    expect(res.status).toBe(400);
    expect(read(STATE)).toBe(before);
  });
});

// The tools' own substitution would turn a request value into the user's env var
// or file, sent to whatever base URL is set: no request value may carry it.
describe("no request value reaches a tool's variable or file substitution", () => {
  const TOKENS = [
    "${OPENAI_API_KEY}", // Hermes, OpenClaw, Droid
    "${env:OPENAI_API_KEY}", // Hermes
    "{env:OPENAI_API_KEY}", // OpenCode, Kilo Code
    "{file:~/.codex/auth.json}", // OpenCode, Kilo Code
    "$OPENAI_API_KEY", // dotenv loaders and shells
    "`cat ~/.codex/auth.json`", // shells
  ];
  // route -> fields -> a valid body with that field set to the value.
  const ROUTES = {
    "claude-settings": {
      "env.ANTHROPIC_BASE_URL": (v) => ({ env: { ANTHROPIC_BASE_URL: v, ANTHROPIC_AUTH_TOKEN: NEW_KEY } }),
      "env.ANTHROPIC_AUTH_TOKEN": (v) => ({ env: { ANTHROPIC_BASE_URL: OWN, ANTHROPIC_AUTH_TOKEN: v } }),
      "env.ANTHROPIC_DEFAULT_OPUS_MODEL": (v) => ({ env: { ANTHROPIC_BASE_URL: OWN, ANTHROPIC_DEFAULT_OPUS_MODEL: v } }),
    },
    "codex-settings": {
      baseUrl: (v) => ({ baseUrl: v, apiKey: NEW_KEY, model: "m1" }),
      apiKey: (v) => ({ baseUrl: OWN, apiKey: v, model: "m1" }),
      model: (v) => ({ baseUrl: OWN, apiKey: NEW_KEY, model: v }),
      subagentModel: (v) => ({ baseUrl: OWN, apiKey: NEW_KEY, model: "m1", subagentModel: v }),
    },
    "hermes-settings": {
      baseUrl: (v) => ({ baseUrl: v, apiKey: NEW_KEY, model: "m1" }),
      apiKey: (v) => ({ baseUrl: OWN, apiKey: v, model: "m1" }),
      model: (v) => ({ baseUrl: OWN, apiKey: NEW_KEY, model: v }),
    },
    "opencode-settings": {
      baseUrl: (v) => ({ baseUrl: v, apiKey: NEW_KEY, models: ["m1"] }),
      apiKey: (v) => ({ baseUrl: OWN, apiKey: v, models: ["m1"] }),
      "models[1]": (v) => ({ baseUrl: OWN, apiKey: NEW_KEY, models: ["m1", v] }),
      model: (v) => ({ baseUrl: OWN, apiKey: NEW_KEY, model: v }),
      activeModel: (v) => ({ baseUrl: OWN, apiKey: NEW_KEY, models: ["m1"], activeModel: v }),
      subagentModel: (v) => ({ baseUrl: OWN, apiKey: NEW_KEY, models: ["m1"], subagentModel: v }),
    },
    "openclaw-settings": {
      baseUrl: (v) => ({ baseUrl: v, apiKey: NEW_KEY, model: "m1" }),
      apiKey: (v) => ({ baseUrl: OWN, apiKey: v, model: "m1" }),
      model: (v) => ({ baseUrl: OWN, apiKey: NEW_KEY, model: v }),
      agentModels: (v) => ({ baseUrl: OWN, apiKey: NEW_KEY, model: "m1", agentModels: { a1: v } }),
    },
    "jcode-settings": {
      baseUrl: (v) => ({ baseUrl: v, apiKey: NEW_KEY, models: ["m1"] }),
      apiKey: (v) => ({ baseUrl: OWN, apiKey: v, models: ["m1"] }),
      models: (v) => ({ baseUrl: OWN, apiKey: NEW_KEY, models: [v] }),
    },
    "droid-settings": {
      baseUrl: (v) => ({ baseUrl: v, apiKey: NEW_KEY, models: ["m1"] }),
      apiKey: (v) => ({ baseUrl: OWN, apiKey: v, models: ["m1"] }),
      models: (v) => ({ baseUrl: OWN, apiKey: NEW_KEY, models: [v] }),
      activeModel: (v) => ({ baseUrl: OWN, apiKey: NEW_KEY, models: ["m1"], activeModel: v }),
    },
    "copilot-settings": {
      baseUrl: (v) => ({ baseUrl: v, apiKey: NEW_KEY, models: ["m1"] }),
      apiKey: (v) => ({ baseUrl: OWN, apiKey: v, models: ["m1"] }),
      models: (v) => ({ baseUrl: OWN, apiKey: NEW_KEY, models: [v] }),
    },
    "deepseek-tui-settings": {
      baseUrl: (v) => ({ baseUrl: v, apiKey: NEW_KEY, model: "m1" }),
      apiKey: (v) => ({ baseUrl: OWN, apiKey: v, model: "m1" }),
      model: (v) => ({ baseUrl: OWN, apiKey: NEW_KEY, model: v }),
    },
    "grok-build-settings": {
      baseUrl: (v) => ({ baseUrl: v, apiKey: NEW_KEY, model: "m1" }),
      apiKey: (v) => ({ baseUrl: OWN, apiKey: v, model: "m1" }),
      model: (v) => ({ baseUrl: OWN, apiKey: NEW_KEY, model: v }),
      subagentModels: (v) => ({ baseUrl: OWN, apiKey: NEW_KEY, model: "m1", subagentModels: { explore: { model: v } } }),
    },
    "cline-settings": {
      baseUrl: (v) => ({ baseUrl: v, apiKey: NEW_KEY, model: "m1" }),
      apiKey: (v) => ({ baseUrl: OWN, apiKey: v, model: "m1" }),
      model: (v) => ({ baseUrl: OWN, apiKey: NEW_KEY, model: v }),
    },
    "kilo-settings": {
      baseUrl: (v) => ({ baseUrl: v, apiKey: NEW_KEY, model: "m1" }),
      apiKey: (v) => ({ baseUrl: OWN, apiKey: v, model: "m1" }),
      model: (v) => ({ baseUrl: OWN, apiKey: NEW_KEY, model: v }),
    },
    "cowork-settings": {
      baseUrl: (v) => ({ baseUrl: v, apiKey: NEW_KEY, models: ["m1"] }),
      apiKey: (v) => ({ baseUrl: OWN, apiKey: v, models: ["m1"] }),
      models: (v) => ({ baseUrl: OWN, apiKey: NEW_KEY, models: [v] }),
      "customPlugins.url": (v) => ({ baseUrl: OWN, apiKey: NEW_KEY, models: ["m1"], customPlugins: [{ name: "mine", url: v }] }),
      "customPlugins.name": (v) => ({ baseUrl: OWN, apiKey: NEW_KEY, models: ["m1"], customPlugins: [{ name: v, url: "https://mcp.example.com/sse" }] }),
      "plugins.url": (v) => ({ baseUrl: OWN, apiKey: NEW_KEY, models: ["m1"], plugins: [{ name: "p1", url: v }] }),
      "plugins.name": (v) => ({ baseUrl: OWN, apiKey: NEW_KEY, models: ["m1"], plugins: [{ name: v, url: "https://mcp.example.com/mcp" }] }),
      "plugins.transport": (v) => ({ baseUrl: OWN, apiKey: NEW_KEY, models: ["m1"], plugins: [{ name: "p1", url: "https://mcp.example.com/mcp", transport: v }] }),
      "plugins.toolNames": (v) => ({ baseUrl: OWN, apiKey: NEW_KEY, models: ["m1"], plugins: [{ name: "p1", url: "https://mcp.example.com/mcp", toolNames: [v] }] }),
    },
  };
  ROUTES["claude-settings"].maxContextTokens = (v) => ({ env: { ANTHROPIC_BASE_URL: OWN }, maxContextTokens: v });

  // Realistic values each kind of field has to keep accepting.
  const PLAIN_URLS = ["https://my-res.openai.azure.com/openai/deployments/gpt-4o?api-version=2024-10-21", `${OWN}/v1`];
  const PLAIN_KEYS = ["sk-proj-Ab_3x-9Q"];
  const PLAIN_MODELS = [
    "cc/claude-opus-4-6",
    "openrouter/anthropic/claude-sonnet-4.5:beta",
    "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
    "claude-sonnet-4-5@20250929",
  ];
  const PLAIN_OTHER = {
    "plugins.name": ["exa", "my_mcp-2"],
    "customPlugins.name": ["my_mcp-2"],
    "plugins.transport": ["http", "sse"],
    "plugins.toolNames": ["web_search_exa"],
    maxContextTokens: ["200000"],
  };
  const isUrlField = (field) => /baseUrl$|BASE_URL$|\.url$/.test(field);
  const plainValues = (field) => {
    if (PLAIN_OTHER[field]) return PLAIN_OTHER[field];
    if (isUrlField(field)) return PLAIN_URLS;
    if (/apiKey$|AUTH_TOKEN$/.test(field)) return PLAIN_KEYS;
    return PLAIN_MODELS;
  };
  const fieldsOf = Object.entries(ROUTES).flatMap(([route, fields]) => Object.entries(fields).map(([field, body]) => [route, field, body]));
  const cases = fieldsOf.flatMap(([route, field, body]) => TOKENS.map((token) => [route, field, token, body]));
  const plainCases = fieldsOf.flatMap(([route, field, body]) => plainValues(field).map((value) => [route, field, value, body]));

  it.each(plainCases)("%s: %s = %s is accepted", async (route, _field, value, body) => {
    expect((await post(route, body(value))).status).toBe(200);
  });

  it.each(cases)("%s: %s = %s is refused and nothing is written", async (route, field, token, body) => {
    const value = isUrlField(field) ? `${OWN}/${token}` : token;
    const res = await post(route, body(value));
    expect(res.status).toBe(400);
    expect((await res.json()).error.startsWith("Invalid ")).toBe(true);
    expect(fs.readdirSync(home)).toEqual([]);
  });

  it.each([["a C1 control", "sk-proj-\u0085x"], ["a line separator", "sk-proj-\u2028x"], ["a paragraph separator", "sk-proj-\u2029x"], ["DEL", "sk-proj-\u007fx"]])(
    "%s in a value is refused",
    async (_label, apiKey) => {
      const res = await post("hermes-settings", { baseUrl: OWN, apiKey, model: "m1" });
      expect(res.status).toBe(400);
      expect(fs.readdirSync(home)).toEqual([]);
    }
  );

  it("the error names the field, the characters and why", async () => {
    const res = await post("droid-settings", { baseUrl: OWN, apiKey: "${ANTHROPIC_API_KEY}", models: ["m1"] });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe(
      "Invalid apiKey: values must be strings and can't contain $ { } \" \\ ` or control characters (they could pull secrets from your machine through the tool's own substitution, or break its config file)"
    );
  });

  it("openclaw: an object apiKey (a secret reference to the user's env) is refused", async () => {
    const res = await post("openclaw-settings", { baseUrl: FOREIGN, model: "m1", apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" } });
    expect(res.status).toBe(400);
    expect((await res.json()).error.startsWith("Invalid apiKey:")).toBe(true);
    expect(fs.readdirSync(home)).toEqual([]);
  });

  it("the reported example bodies are refused", async () => {
    const opencode = await post("opencode-settings", { baseUrl: FOREIGN, apiKey: "{env:OPENAI_API_KEY}", models: ["m1"] });
    expect(opencode.status).toBe(400);
    expect((await opencode.json()).error.startsWith("Invalid apiKey:")).toBe(true);
    const opencodeFile = await post("opencode-settings", { baseUrl: FOREIGN, apiKey: NEW_KEY, models: ["{file:~/.codex/auth.json}"] });
    expect((await opencodeFile.json()).error.startsWith("Invalid models[0]:")).toBe(true);
    const openclaw = await post("openclaw-settings", { baseUrl: FOREIGN, model: "m", apiKey: "${OPENAI_API_KEY}" });
    expect(openclaw.status).toBe(400);
    expect((await openclaw.json()).error.startsWith("Invalid apiKey:")).toBe(true);
    expect(fs.readdirSync(home)).toEqual([]);
  });
});
