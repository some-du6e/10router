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

const { POST } = await import("@/app/api/cli-tools/codex-settings/route.js");

const configPath = path.join(home, ".codex", "config.toml");
const apply = (body) => POST(new Request("http://localhost/api/cli-tools/codex-settings", {
  method: "POST",
  body: JSON.stringify({ apiKey: "sk-test", model: "acme/claude-opus-5-5", ...body }),
}));
const provider = () => parseTOML(fs.readFileSync(configPath, "utf8")).model_providers["10router"];

afterAll(() => {
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
