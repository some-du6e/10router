import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { collectIconNames } from "../../scripts/icon-names.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const manifest = readFileSync(new URL("../../src/app/fonts/material-symbols-outlined.icons.txt", import.meta.url), "utf8").split("\n").filter(Boolean);

describe("icon font subset", () => {
  // The dashboard ships a subset of Material Symbols. An icon missing from it
  // renders as its raw name, so a newly used one has to be added to the font.
  it("contains every icon the source references", () => {
    // index.d.ts lags the font a little; the subset script reads the font's own
    // ligature table, which needs python, so this check uses the package list.
    const known = new Set(readFileSync(new URL("../../node_modules/material-symbols/index.d.ts", import.meta.url), "utf8").match(/(?<=")[a-z0-9_]+(?=")/g));
    const missing = collectIconNames(root, known).filter((name) => !manifest.includes(name));
    expect(missing, "run `node scripts/subset-icon-font.mjs`").toEqual([]);
  });
});
