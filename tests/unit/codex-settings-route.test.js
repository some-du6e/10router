import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { parseTOML } from "confbox";

// The route writes <os.homedir()>/.codex/config.toml. os.homedir() reads
// USERPROFILE on Windows, not HOME, so mock it: this test must never reach a
// real Codex config.
const fakeHome = vi.hoisted(() => ({ dir: null }));
vi.mock("os", async (importOriginal) => {
  const actual = await importOriginal();
  const homedir = () => {
    if (!fakeHome.dir) throw new Error("codex-settings test: home not set");
    return fakeHome.dir;
  };
  return { ...actual, homedir, default: { ...(actual.default ?? actual), homedir } };
});

// The route asks the installed Codex for its version; this stands in for it.
const codex = vi.hoisted(() => ({ version: "codex-cli 0.167.2", onAsk: null }));
vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal();
  const { promisify: p } = await import("node:util");
  const run = async (command) => {
    if (command === "codex --version") {
      if (codex.onAsk) await codex.onAsk();
      if (codex.version === null) throw new Error("codex: command not found");
      return { stdout: `${codex.version}\n`, stderr: "" };
    }
    return { stdout: "", stderr: "" };
  };
  const exec = (command, options, callback) => {
    run(command).then(({ stdout, stderr }) => callback(null, stdout, stderr), (error) => callback(error));
  };
  exec[p.custom] = run;
  return { ...actual, exec, default: { ...(actual.default ?? actual), exec } };
});

const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-settings-"));
fakeHome.dir = home;
// Backstop in case the mock ever stops applying.
const originalEnv = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
process.env.HOME = home;
process.env.USERPROFILE = home;

// Refuse to run a single test unless the route's home is this temp dir.
const routeHome = (await import("os")).homedir();
if (routeHome !== home) throw new Error(`codex-settings test: os.homedir() is ${routeHome}, not the temp dir; refusing to write a Codex config`);
if (!(await import("child_process")).exec[promisify.custom]) throw new Error("codex-settings test: child_process mock not applied");

// The route looks the API key's allowlist up in the router's database.
const originalDataDir = process.env.DATA_DIR;
process.env.DATA_DIR = path.join(home, "data");
delete global._dbAdapter;
const db = await import("@/lib/db/index.js");
await (await import("@/lib/db/driver.js")).getAdapter();

const { POST } = await import("@/app/api/cli-tools/codex-settings/route.js");
const { resetRoutedModels } = await import("@/lib/codex/routedModels.js");
const { wantsCatalogUrl } = await import("@/lib/codex/catalogUrlDecision.js");

const configPath = path.join(home, ".codex", "config.toml");
const config = () => parseTOML(fs.readFileSync(configPath, "utf8"));
const keyWith = async (name, allowedModels) => {
  const created = await db.createApiKey(name, "machine-test-0001");
  if (allowedModels) await db.updateApiKey(created.id, { allowedModels });
  return (await db.getApiKeyById(created.id)).key;
};
const apply = (body) => POST(new Request("http://localhost/api/cli-tools/codex-settings", {
  method: "POST",
  body: JSON.stringify({ apiKey: "sk-test", model: "cx/gpt-5.5", ...body }),
}));
const provider = () => config().model_providers["10router"];
const URL_LINE = "http://127.0.0.1:20128/backend-api/codex/models";

afterAll(() => {
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  for (const [name, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  fs.rmSync(home, { recursive: true, force: true });
});

beforeEach(() => {
  codex.version = "codex-cli 0.167.2";
  codex.onAsk = null;
  // The decision reads the routed model list, which these tests change.
  resetRoutedModels();
  fs.rmSync(path.join(home, ".codex"), { recursive: true, force: true });
});

describe("Codex CLI settings", () => {
  it("writes into the test's own home, whatever HOME or USERPROFILE say", async () => {
    const { homedir } = await import("os");
    expect(homedir()).toBe(home);
    expect(home.startsWith(os.tmpdir())).toBe(true);
  });

  it("points Codex 0.166 or newer at the router's catalog on the native endpoint", async () => {
    expect((await apply({ baseUrl: "http://127.0.0.1:20128" })).status).toBe(200);
    expect(provider()).toEqual({
      name: "openai",
      base_url: "http://127.0.0.1:20128/backend-api/codex",
      model_catalog_url: URL_LINE,
      wire_api: "responses",
      requires_openai_auth: true,
    });
  });

  it("writes the same catalog URL when the base URL already carries the native path", async () => {
    await apply({ baseUrl: "https://router.example/backend-api/codex/" });
    expect(provider().model_catalog_url).toBe("https://router.example/backend-api/codex/models");
  });

  it("says in its answer whether it wrote the catalog URL, and why not", async () => {
    const answer = async (body) => (await apply({ baseUrl: "http://127.0.0.1:20128", ...body })).json();
    expect((await answer({})).catalogUrl).toEqual({ written: true, reason: "listed" });
    codex.version = "codex-cli 0.165.0";
    expect((await answer({})).catalogUrl).toEqual({ written: false, reason: "codex-version" });
    codex.version = "codex-cli 0.167.2";
    expect((await answer({ model: "acme/not-a-model" })).catalogUrl).toEqual({ written: false, reason: "not-listed" });
    expect((await answer({ native: false })).catalogUrl).toEqual({ written: false, reason: "not-native" });
  });

  it("keeps what was written to config.toml while it was deciding", async () => {
    fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
    fs.writeFileSync(configPath, 'model = "old"\n');
    // Codex (or a Reset) writes to the file while Apply checks the version.
    codex.onAsk = async () => {
      fs.writeFileSync(configPath, 'model = "old"\n[projects."/work/repo"]\ntrust_level = "trusted"\n');
    };
    await apply({ baseUrl: "http://127.0.0.1:20128" });
    expect(config().projects["/work/repo"]).toEqual({ trust_level: "trusted" });
    expect(config().model).toBe("cx/gpt-5.5");
    expect(provider().model_catalog_url).toBe(URL_LINE);
  });

  it("drops the catalog URL when switching to the OpenAI-compatible endpoint", async () => {
    await apply({ baseUrl: "http://127.0.0.1:20128" });
    await apply({ baseUrl: "http://127.0.0.1:20128", native: false });
    expect(provider()).toEqual({ name: "10router", base_url: "http://127.0.0.1:20128/v1", wire_api: "responses" });
  });
});

describe("the catalog URL for the installed Codex", () => {
  // 0.160 to 0.165 drop their own list for it and end up with none when the
  // fetch fails or the body is over 1 MiB; 0.156 to 0.159 merge it, capped.
  it.each([
    ["codex-cli 0.166.0", URL_LINE],
    ["codex-cli 0.167.2", URL_LINE],
    ["codex-cli 0.0.0", URL_LINE],
    ["codex-cli 0.165.0", null],
    ["codex-cli 0.160.0", null],
    ["codex-cli 0.156.0", null],
    ["codex-cli 0.137.0", null],
    ["something else", null],
    [null, null],
  ])("%s gets %s", async (version, expected) => {
    codex.version = version;
    await apply({ baseUrl: "http://127.0.0.1:20128" });
    expect(provider().model_catalog_url ?? null).toBe(expected);
  });
});

describe("the catalog URL for a key with a model allowlist", () => {
  const setup = (apiKey, model, subagentModel) =>
    apply({ baseUrl: "http://127.0.0.1:20128", apiKey, model, subagentModel });
  const written = () => ({
    model: config().model,
    subagent: config().agents.default_subagent_model,
    catalog: provider().model_catalog_url ?? null,
  });

  // Codex with model_catalog_url looks `model` up by exact name, so the line
  // goes in only when the key's catalog lists both models under these ids.
  it("is left out when the key was allowed the model by its bare name", async () => {
    const key = await keyWith("bare-allowlist", ["gpt-5.5", "cc/claude-opus-5-5"]);
    await setup(key, "cx/gpt-5.5", "cc/claude-opus-5-5");
    expect(written()).toEqual({ model: "cx/gpt-5.5", subagent: "cc/claude-opus-5-5", catalog: null });
  });

  it("is written when the allowlist names both models by these ids, and for an open key or one not on file", async () => {
    const prefixed = await keyWith("prefixed-allowlist", ["cx/gpt-5.5", "cc/claude-opus-5-5"]);
    for (const key of [prefixed, await keyWith("no-allowlist"), "sk_10router"]) {
      await setup(key, "cx/gpt-5.5", "cc/claude-opus-5-5");
      expect(written()).toEqual({ model: "cx/gpt-5.5", subagent: "cc/claude-opus-5-5", catalog: URL_LINE });
    }
  });

  it("is left out when the allowlist doesn't cover the subagent model", async () => {
    const key = await keyWith("partial-allowlist", ["cx/gpt-5.5"]);
    await setup(key, "cx/gpt-5.5", "cc/claude-opus-5-5");
    expect(written().catalog).toBeNull();
  });

  it("is written for a combo the key is allowed, picked by its name", async () => {
    await db.createCombo({ name: "codex-team", models: ["cx/gpt-5.5", "cc/claude-opus-5-5"] });
    const key = await keyWith("combo-only", ["codex-team"]);
    await setup(key, "codex-team", "codex-team");
    expect(written()).toEqual({ model: "codex-team", subagent: "codex-team", catalog: URL_LINE });
  });

  it("is written for a prefixed model next to a combo in the allowlist", async () => {
    await db.createCombo({ name: "mixed-team", models: ["cx/gpt-5.5"] });
    const key = await keyWith("combo-and-model", ["mixed-team", "cc/claude-opus-5-5"]);
    await setup(key, "cc/claude-opus-5-5", "cc/claude-opus-5-5");
    expect(written().catalog).toBe(URL_LINE);
  });

  // The catalog lists what an alias points to, not the alias itself.
  it("is left out for an alias picked by its name, which the catalog doesn't list", async () => {
    await db.setModelAlias("team-opus", "cc/claude-opus-5-5");
    const key = await keyWith("alias-only", ["team-opus"]);
    await setup(key, "team-opus", "team-opus");
    expect(written()).toEqual({ model: "team-opus", subagent: "team-opus", catalog: null });
  });

  it("is left out for a model the router doesn't list at all", async () => {
    await setup("sk_10router", "acme/not-a-model", "acme/not-a-model");
    expect(written().catalog).toBeNull();
  });

  it("is left out when the key's allowlist can't be read", async () => {
    const listIds = async () => { throw new Error("database is locked"); };
    expect(await wantsCatalogUrl({ apiKey: "k", ids: ["cx/gpt-5.5"], codexVersion: [0, 167, 2], listIds })).toBe(false);
    expect(await wantsCatalogUrl({ apiKey: "k", ids: ["cx/gpt-5.5"], codexVersion: [0, 167, 2], listIds: async () => new Set(["cx/gpt-5.5"]) })).toBe(true);
    expect(await wantsCatalogUrl({ apiKey: "k", ids: ["", ""], codexVersion: [0, 167, 2], listIds: async () => new Set() })).toBe(false);
  });

  it("never writes the key into config.toml", async () => {
    const key = await keyWith("secret-check", ["gpt-5.5"]);
    await setup(key, "cx/gpt-5.5", "cx/gpt-5.5");
    expect(fs.readFileSync(configPath, "utf8")).not.toContain(key);
  });
});
