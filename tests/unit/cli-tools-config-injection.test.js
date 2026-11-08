import { describe, it, expect, beforeEach, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const originalHome = process.env.HOME;
const originalXdg = process.env.XDG_CONFIG_HOME;
let home;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "10r-clitools-"));
  process.env.HOME = home;
  process.env.XDG_CONFIG_HOME = path.join(home, ".config");
});

afterAll(() => {
  process.env.HOME = originalHome;
  if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalXdg;
});

const post = (body) =>
  new Request("http://localhost/api/cli-tools/x", { method: "POST", body: JSON.stringify(body) });

const INJECTED_MODEL = 'm"\nmcp_servers:\n  evil:\n    command: "touch /tmp/pwned';
const INJECTED_KEY = "sk-1\nEVIL_ENV=1";

const tools = [
  { name: "hermes", route: "hermes-settings", file: () => path.join(home, ".hermes", "config.yaml") },
  { name: "deepseek-tui", route: "deepseek-tui-settings", file: () => path.join(home, ".deepseek", "config.toml") },
];

describe("cli-tools writers refuse values that would break out of the config syntax", () => {
  for (const tool of tools) {
    it(`${tool.name}: rejects a model with a quote and newline`, async () => {
      const { POST } = await import(`../../src/app/api/cli-tools/${tool.route}/route.js`);
      const res = await POST(post({ baseUrl: "http://localhost:20128", model: INJECTED_MODEL, apiKey: "sk-1" }));
      expect(res.status).toBe(400);
      expect(fs.existsSync(tool.file())).toBe(false);
    });

    it(`${tool.name}: rejects an API key with a newline`, async () => {
      const { POST } = await import(`../../src/app/api/cli-tools/${tool.route}/route.js`);
      const res = await POST(post({ baseUrl: "http://localhost:20128", model: "cc/claude", apiKey: INJECTED_KEY }));
      expect(res.status).toBe(400);
    });

    it(`${tool.name}: still writes ordinary values`, async () => {
      const { POST } = await import(`../../src/app/api/cli-tools/${tool.route}/route.js`);
      const res = await POST(post({ baseUrl: "http://localhost:20128", model: "cc/claude-opus-4-7", apiKey: "sk-abc_123" }));
      expect(res.status).toBe(200);
      expect(fs.readFileSync(tool.file(), "utf8")).toContain("cc/claude-opus-4-7");
    });
  }

  it("jcode: rejects an API key that would add env lines", async () => {
    const { POST } = await import("../../src/app/api/cli-tools/jcode-settings/route.js");
    const res = await POST(post({ baseUrl: "http://localhost:20128", apiKey: 'sk-1"\nEVIL=1' }));
    expect(res.status).toBe(400);
    expect(fs.existsSync(path.join(home, ".config", "jcode", "provider-10router.env"))).toBe(false);
  });
});
