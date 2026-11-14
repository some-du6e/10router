// When the Codex config the dashboard shows or writes gets model_catalog_url.
import { describe, it, expect } from "vitest";
import {
  parseCodexVersion, codexReadsCatalogUrl, allowlistListsIds, manualCatalogLines,
} from "@/shared/utils/codexCatalog.js";

const BASE = "http://127.0.0.1:20128/backend-api/codex";

describe("Codex version", () => {
  it("reads the version `codex --version` prints", () => {
    expect(parseCodexVersion("codex-cli 0.167.2\n")).toEqual([0, 167, 2]);
    expect(parseCodexVersion("codex-cli 0.158.0-alpha.3")).toEqual([0, 158, 0]);
    expect(parseCodexVersion("")).toBeNull();
    expect(parseCodexVersion(undefined)).toBeNull();
  });

  it("uses the catalog URL from 0.166.0, and not for an unknown version", () => {
    expect(codexReadsCatalogUrl([0, 166, 0])).toBe(true);
    expect(codexReadsCatalogUrl([0, 167, 2])).toBe(true);
    expect(codexReadsCatalogUrl([1, 0, 0])).toBe(true);
    expect(codexReadsCatalogUrl([0, 165, 9])).toBe(false);
    expect(codexReadsCatalogUrl([0, 160, 0])).toBe(false);
    expect(codexReadsCatalogUrl([0, 156, 0])).toBe(false);
    expect(codexReadsCatalogUrl(null)).toBe(false);
  });
});

describe("a key's allowlist", () => {
  it("lists the models under these ids only when it names them by these ids", () => {
    expect(allowlistListsIds(undefined, ["cx/gpt-5.5"])).toBe(true);
    expect(allowlistListsIds([], ["cx/gpt-5.5"])).toBe(true);
    expect(allowlistListsIds(["cx/gpt-5.5", "cc/claude-opus-5-5"], ["cx/gpt-5.5", "cc/claude-opus-5-5"])).toBe(true);
    expect(allowlistListsIds(["gpt-5.5"], ["cx/gpt-5.5"])).toBe(false);
    expect(allowlistListsIds(["cx/gpt-5.5"], ["cx/gpt-5.5", "cc/claude-opus-5-5"])).toBe(false);
    expect(allowlistListsIds(["my-combo"], ["my-combo"])).toBe(true);
    expect(allowlistListsIds(["my-combo", "cc/claude-opus-5-5"], ["cc/claude-opus-5-5"])).toBe(true);
  });
});

describe("the manual config's catalog lines", () => {
  const ids = ["cx/gpt-5.5", "cx/gpt-5.5"];

  it("carry the URL and the version note for a key without an allowlist", () => {
    const lines = manualCatalogLines(BASE, { allowedModels: [] }, ids);
    expect(lines).toBe(`# Needs Codex 0.166 or newer; remove for older Codex.\nmodel_catalog_url = "${BASE}/models"\n`);
  });

  it("are left out for a key whose allowlist doesn't name the models by these ids", () => {
    expect(manualCatalogLines(BASE, { allowedModels: ["gpt-5.5"] }, ids)).toBe("");
  });

  it("add a note about allowlists for a key the card doesn't know", () => {
    const lines = manualCatalogLines(BASE, null, ids);
    expect(lines).toContain("# Needs Codex 0.166 or newer; remove for older Codex.");
    expect(lines).toContain("allowlist");
    expect(lines.endsWith(`model_catalog_url = "${BASE}/models"\n`)).toBe(true);
  });
});
