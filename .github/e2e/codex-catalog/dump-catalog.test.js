// Copied into tests/unit/ by .github/workflows/codex-model-catalog.yml, on this
// branch and on the base, to write what a real Codex reads from the router:
// the /backend-api/codex/models body and the config.toml the dashboard's Codex
// setup writes. Nothing here talks to a model or an account.
//
//   CODEX_CATALOG_OUT       where the catalog body goes
//   CODEX_SETUP_HOME        HOME for the settings route (writes .codex/config.toml)
//   CODEX_ROUTER_URL        the base URL given to the settings route
//   CODEX_UPSTREAM_FIXTURE  optional: a Codex catalog served as the ChatGPT backend's
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { it, vi } from "vitest";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "codex-catalog-dump-"));

it("writes the Codex catalog and the dashboard's Codex config", async () => {
  const fixture = process.env.CODEX_UPSTREAM_FIXTURE;
  if (fixture) {
    const upstream = JSON.parse(fs.readFileSync(fixture, "utf8")).models;
    vi.doMock("@/sse/services/codexUpstreamCatalog.js", () => ({ getCodexUpstreamModels: async () => upstream }));
  }
  const { GET } = await import("@/app/api/v1/codex/models/route.js");
  const response = await GET(new Request("http://localhost/backend-api/codex/models?client_version=0.167.2"));
  fs.writeFileSync(process.env.CODEX_CATALOG_OUT, await response.text());

  process.env.HOME = process.env.CODEX_SETUP_HOME;
  const { POST } = await import("@/app/api/cli-tools/codex-settings/route.js");
  const setup = await POST(new Request("http://localhost/api/cli-tools/codex-settings", {
    method: "POST",
    body: JSON.stringify({ baseUrl: process.env.CODEX_ROUTER_URL, apiKey: "unused", model: "cx/gpt-5.5" }),
  }));
  if (setup.status !== 200) throw new Error(`settings route answered ${setup.status}`);
});
