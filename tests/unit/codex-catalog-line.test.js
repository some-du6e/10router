// When the Codex config the dashboard shows or writes gets model_catalog_url.
import { describe, it, expect } from "vitest";
import { parseCodexVersion, codexReadsCatalogUrl, manualCatalogLines, catalogUrlNote } from "@/shared/utils/codexCatalog.js";

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
    // Compared as numbers: "99" > "166" as text.
    expect(codexReadsCatalogUrl([0, 99, 0])).toBe(false);
    expect(codexReadsCatalogUrl(null)).toBe(false);
  });

  it("counts a source build's 0.0.0 as the newest, as the catalog does", () => {
    expect(codexReadsCatalogUrl([0, 0, 0])).toBe(true);
  });
});

describe("the manual config's catalog lines", () => {
  it("carry the URL commented out, with when to uncomment it", () => {
    const lines = manualCatalogLines(BASE);
    expect(lines.split("\n").filter((l) => l && !l.startsWith("#"))).toEqual([]);
    expect(lines).toContain(`# model_catalog_url = "${BASE}/models"`);
    expect(lines).toContain("0.166");
    expect(lines).toContain("`model`");
    expect(lines).toContain("`default_subagent_model`");
    expect(lines).toContain("alias");
    expect(lines.endsWith("\n")).toBe(true);
  });
});

describe("the note after Apply", () => {
  it("says whether the catalog URL was written, and why not", () => {
    expect(catalogUrlNote({ written: true, reason: "listed" })).toContain("model_catalog_url");
    expect(catalogUrlNote({ written: false, reason: "codex-version" })).toContain("0.166");
    expect(catalogUrlNote({ written: false, reason: "not-listed" })).toContain("exact ids");
    expect(catalogUrlNote({ written: false, reason: "lookup-failed" })).toContain("couldn't be read");
    expect(catalogUrlNote({ written: false, reason: "not-native" })).toBe("");
    expect(catalogUrlNote(undefined)).toBe("");
  });
});
