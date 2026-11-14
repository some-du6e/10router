import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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

const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-settings-"));
fakeHome.dir = home;
// Backstop in case the mock ever stops applying.
const originalEnv = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
process.env.HOME = home;
process.env.USERPROFILE = home;

// Refuse to run a single test unless the route's home is this temp dir.
const routeHome = (await import("os")).homedir();
if (routeHome !== home) throw new Error(`codex-settings test: os.homedir() is ${routeHome}, not the temp dir; refusing to write a Codex config`);

// The route looks the API key's allowlist up in the router's database.
const originalDataDir = process.env.DATA_DIR;
process.env.DATA_DIR = path.join(home, "data");
delete global._dbAdapter;
const db = await import("@/lib/db/index.js");
await (await import("@/lib/db/driver.js")).getAdapter();

const { POST } = await import("@/app/api/cli-tools/codex-settings/route.js");

const configPath = path.join(home, ".codex", "config.toml");
const config = () => parseTOML(fs.readFileSync(configPath, "utf8"));
const keyWith = async (name, allowedModels) => {
  const created = await db.createApiKey(name, "machine-test-0001");
  if (allowedModels) await db.updateApiKey(created.id, { allowedModels });
  return (await db.getApiKeyById(created.id)).key;
};
const apply = (body) => POST(new Request("http://localhost/api/cli-tools/codex-settings", {
  method: "POST",
  body: JSON.stringify({ apiKey: "sk-test", model: "acme/claude-opus-5-5", ...body }),
}));
const provider = () => parseTOML(fs.readFileSync(configPath, "utf8")).model_providers["10router"];

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
  fs.rmSync(path.join(home, ".codex"), { recursive: true, force: true });
});

describe("Codex CLI settings", () => {
  it("writes into the test's own home, whatever HOME or USERPROFILE say", async () => {
    const { homedir } = await import("os");
    expect(homedir()).toBe(home);
    expect(home.startsWith(os.tmpdir())).toBe(true);
  });

  it("points an API-key login at the router's catalog on the native endpoint", async () => {
    expect((await apply({ baseUrl: "http://127.0.0.1:20128" })).status).toBe(200);
    expect(provider()).toEqual({
      name: "openai",
      base_url: "http://127.0.0.1:20128/backend-api/codex",
      model_catalog_url: "http://127.0.0.1:20128/backend-api/codex/models",
      wire_api: "responses",
      requires_openai_auth: true,
    });
  });

  it("writes the same catalog URL when the base URL already carries the native path", async () => {
    await apply({ baseUrl: "https://router.example/backend-api/codex/" });
    expect(provider().model_catalog_url).toBe("https://router.example/backend-api/codex/models");
  });

  it("drops the catalog URL when switching to the OpenAI-compatible endpoint", async () => {
    await apply({ baseUrl: "http://127.0.0.1:20128" });
    await apply({ baseUrl: "http://127.0.0.1:20128", native: false });
    expect(provider()).toEqual({ name: "10router", base_url: "http://127.0.0.1:20128/v1", wire_api: "responses" });
  });
});

describe("the catalog URL for a key with a model allowlist", () => {
  const setup = (apiKey, model = "cx/gpt-5.5", subagentModel = "cc/claude-opus-5-5") =>
    apply({ baseUrl: "http://127.0.0.1:20128", apiKey, model, subagentModel });
  const written = () => ({
    model: config().model,
    subagent: config().agents.default_subagent_model,
    catalog: provider().model_catalog_url ?? null,
  });

  // Codex with model_catalog_url looks `model` up by exact name, and such a
  // key's catalog lists the model under the bare name only; without the URL
  // Codex keeps its own list and prefix matching, as before the catalog.
  it("is left out when the allowlist names a model without a provider prefix", async () => {
    const key = await keyWith("bare-allowlist", ["gpt-5.5", "cc/claude-opus-5-5"]);
    await setup(key);
    expect(written()).toEqual({ model: "cx/gpt-5.5", subagent: "cc/claude-opus-5-5", catalog: null });
  });

  it("is written for a prefixed-only allowlist, no allowlist, or a key not on file", async () => {
    const url = "http://127.0.0.1:20128/backend-api/codex/models";
    for (const key of [await keyWith("prefixed-allowlist", ["cx/gpt-5.5"]), await keyWith("no-allowlist"), "sk_10router"]) {
      await setup(key);
      expect(written()).toEqual({ model: "cx/gpt-5.5", subagent: "cc/claude-opus-5-5", catalog: url });
    }
  });

  it("never writes the key into config.toml", async () => {
    const key = await keyWith("secret-check", ["gpt-5.5"]);
    await setup(key);
    expect(fs.readFileSync(configPath, "utf8")).not.toContain(key);
  });
});
