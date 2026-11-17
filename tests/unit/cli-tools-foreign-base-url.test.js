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

// No installed tools to ask: `which`, `codex --version` and the like fail.
vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal();
  const { promisify: p } = await import("node:util");
  const run = async () => { throw new Error("command not found"); };
  const exec = (command, options, callback) => {
    (typeof options === "function" ? options : callback)(new Error("command not found"));
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

  it.each([[true], [false]])("native=%s without a usable key: 400, config.toml untouched", async (native) => {
    write(CONFIG, EXISTING);
    const res = await post("codex-settings", { baseUrl: FOREIGN, apiKey: "   ", model: "m1", native });
    expect(res.status).toBe(400);
    const { error } = await res.json();
    expect(error).toContain("~/.codex/auth.json");
    expect(error).toContain("https://attacker.example.net");
    expect(error).toMatch(/choose a key/);
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

  it("re-applying the same foreign base URL still writes the key: the stored URL vouches for nothing", async () => {
    await post("codex-settings", { baseUrl: FOREIGN, apiKey: NEW_KEY, model: "m1" });
    const refused = await post("codex-settings", { baseUrl: FOREIGN, apiKey: " ", model: "m1" });
    expect(refused.status).toBe(400);
    const again = await post("codex-settings", { baseUrl: FOREIGN, apiKey: NEW_KEY, model: "m2" });
    expect(again.status).toBe(200);
    expect(provider().experimental_bearer_token).toBe(NEW_KEY);
  });

  it("this instance: unchanged, Codex's own login and no key in config.toml", async () => {
    const res = await post("codex-settings", { baseUrl: OWN, apiKey: NEW_KEY, model: "m1" });
    expect(res.status).toBe(200);
    expect(provider()).toEqual({
      name: "openai",
      base_url: `${OWN}/backend-api/codex`,
      wire_api: "responses",
      requires_openai_auth: true,
    });
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
      const { error } = await res.json();
      expect(error).toContain("OPENAI_API_KEY from ~/.hermes/.env");
      expect(error).toMatch(/choose a key/);
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
    expect((await post("hermes-settings", { baseUrl: FOREIGN, model: "m1" })).status).toBe(400);
    expect(read(CONFIG)).toContain(`api_key: "${NEW_KEY}"`);
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

describe("claude: a foreign base URL never gets Claude Code's own login", () => {
  const SETTINGS = ".claude/settings.json";

  beforeEach(() => {
    write(SETTINGS, { env: { ANTHROPIC_BASE_URL: `${OWN}/v1` } });
  });

  it.each([["a blank token", "   "], ["a numeric token", 12345]])("with %s: 400, settings.json untouched", async (_label, token) => {
    const res = await post("claude-settings", { env: { ANTHROPIC_BASE_URL: FOREIGN, ANTHROPIC_AUTH_TOKEN: token } });
    expect(res.status).toBe(400);
    const { error } = await res.json();
    expect(error).toContain("its own Claude login");
    expect(error).toMatch(/choose a key/);
    expect(readJson(SETTINGS)).toEqual({ env: { ANTHROPIC_BASE_URL: `${OWN}/v1` } });
  });

  it("a base URL that isn't a string is a 400, not a 500", async () => {
    const res = await post("claude-settings", { env: { ANTHROPIC_BASE_URL: 8080 } });
    expect(res.status).toBe(400);
    expect(readJson(SETTINGS)).toEqual({ env: { ANTHROPIC_BASE_URL: `${OWN}/v1` } });
  });

  it("with a token: written, so Claude Code sends it instead of its login", async () => {
    const res = await post("claude-settings", { env: { ANTHROPIC_BASE_URL: FOREIGN, ANTHROPIC_AUTH_TOKEN: NEW_KEY } });
    expect(res.status).toBe(200);
    expect(readJson(SETTINGS).env).toMatchObject({ ANTHROPIC_BASE_URL: `${FOREIGN}/v1`, ANTHROPIC_AUTH_TOKEN: NEW_KEY });
  });

  it("this instance: unchanged, no token needed", async () => {
    const res = await post("claude-settings", { env: { ANTHROPIC_BASE_URL: "http://localhost:20128" } });
    expect(res.status).toBe(200);
    expect(readJson(SETTINGS).env.ANTHROPIC_BASE_URL).toBe("http://localhost:20128/v1");
  });
});

describe("opencode: stored provider headers never follow a foreign base URL", () => {
  const CONFIG = ".config/opencode/opencode.json";
  const withHeaders = (headers) => ({
    provider: { "10router": { npm: "@ai-sdk/openai-compatible", options: { baseURL: `${OWN}/v1`, apiKey: USER_KEY, ...(headers ? { headers } : {}) }, models: {} } },
  });

  it("stored headers: 400 naming them, opencode.json untouched", async () => {
    write(CONFIG, withHeaders({ Authorization: "Bearer sk-placeholder-header-token" }));
    const before = read(CONFIG);
    const res = await post("opencode-settings", { baseUrl: FOREIGN, apiKey: NEW_KEY, models: ["m1"] });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("opencode.json has provider.10router.options.headers; remove it or point OpenCode back at this instance");
    expect(read(CONFIG)).toBe(before);
  });

  it("no stored headers: the request's key is written with the base URL", async () => {
    write(CONFIG, withHeaders(null));
    const res = await post("opencode-settings", { baseUrl: FOREIGN, apiKey: NEW_KEY, models: ["m1"] });
    expect(res.status).toBe(200);
    expect(readJson(CONFIG).provider["10router"].options).toEqual({ baseURL: `${FOREIGN}/v1`, apiKey: NEW_KEY });
  });

  it("this instance: unchanged, stored headers stay", async () => {
    write(CONFIG, withHeaders({ "x-placeholder": "1" }));
    const res = await post("opencode-settings", { baseUrl: "http://localhost:20128", apiKey: NEW_KEY, models: ["m1"] });
    expect(res.status).toBe(200);
    expect(readJson(CONFIG).provider["10router"].options).toEqual({ baseURL: "http://localhost:20128/v1", apiKey: NEW_KEY, headers: { "x-placeholder": "1" } });
  });
});

describe("cline: stored openAiHeaders never follow a foreign base URL", () => {
  const STATE = ".cline/data/globalState.json";
  const SECRETS = ".cline/data/secrets.json";

  it("stored headers: 400 naming them, nothing written", async () => {
    write(STATE, { openAiBaseUrl: OWN, openAiHeaders: { Authorization: "Bearer sk-placeholder-header-token" } });
    write(SECRETS, { openAiApiKey: USER_KEY });
    const res = await post("cline-settings", { baseUrl: FOREIGN, apiKey: NEW_KEY, model: "m1" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("globalState.json has openAiHeaders; remove it or point Cline back at this instance");
    expect(readJson(STATE).openAiBaseUrl).toBe(OWN);
    expect(readJson(SECRETS)).toEqual({ openAiApiKey: USER_KEY });
  });

  it("no stored headers: the request's key is written with the base URL", async () => {
    write(STATE, { openAiBaseUrl: OWN, openAiHeaders: {} });
    const res = await post("cline-settings", { baseUrl: FOREIGN, apiKey: NEW_KEY, model: "m1" });
    expect(res.status).toBe(200);
    expect(readJson(STATE).openAiBaseUrl).toBe(FOREIGN);
    expect(readJson(SECRETS)).toEqual({ openAiApiKey: NEW_KEY });
  });

  it("this instance: unchanged, stored headers stay", async () => {
    write(STATE, { openAiBaseUrl: FOREIGN, openAiHeaders: { "x-placeholder": "1" } });
    const res = await post("cline-settings", { baseUrl: `${OWN}/v1`, apiKey: NEW_KEY, model: "m1" });
    expect(res.status).toBe(200);
    expect(readJson(STATE)).toMatchObject({ openAiBaseUrl: OWN, openAiHeaders: { "x-placeholder": "1" } });
  });
});
