// Builds src/app/fonts/material-symbols-outlined.woff2: the Material Symbols
// font cut down to the icons this app references. The vendor file is ~3.9 MB,
// which on a slow link means seconds of raw ligature names ("chevron_right")
// before the glyphs paint; the subset is ~50 KB.
//
// Rerun after using an icon that is not in the font yet (tests/unit/icon-font-subset
// fails when that happens): node scripts/subset-icon-font.mjs
// Needs python3 with fonttools and brotli (pip install fonttools brotli).
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { collectIconNames } from "./icon-names.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const source = join(root, "node_modules/material-symbols/material-symbols-outlined.woff2");
const output = join(root, "src/app/fonts/material-symbols-outlined.woff2");
const manifest = join(root, "src/app/fonts/material-symbols-outlined.icons.txt");

// The font's own ligature table is the list of valid names. The package's
// index.d.ts lags it (no expand_more, no done), and glyph names differ from
// ligatures for icons that start with a digit (_10k).
const listLigatures = `
import sys
from fontTools.ttLib import TTFont
font = TTFont(sys.argv[1])
chars = {g: chr(c) for c, g in font.getBestCmap().items()}
for lookup in font["GSUB"].table.LookupList.Lookup:
    for sub in lookup.SubTable:
        if sub.LookupType == 7:
            sub = sub.ExtSubTable
        if sub.LookupType != 4:
            continue
        for first, ligatures in sub.ligatures.items():
            for lig in ligatures:
                if all(g in chars for g in [first] + lig.Component):
                    print("".join(chars[g] for g in [first] + lig.Component))
`;
const known = new Set(execFileSync("python3", ["-P", "-c", listLigatures, source], { encoding: "utf8", maxBuffer: 16 << 20 }).split("\n").filter(Boolean));
const icons = collectIconNames(root, known);

const work = mkdtempSync(join(tmpdir(), "icon-subset-"));
try {
  // The subsetter keeps every ligature whose letters survive, and every icon
  // is spelled from a-z0-9_, so trimming by codepoint keeps all ~4k icons.
  // Drop the unwanted ligatures from GSUB first, then subset what is left.
  // Filled variants are separate glyphs the FILL axis swaps in (a feature
  // variation the subsetter keeps for the glyphs we retain), so .fill-1 works.
  const pruneLigatures = `
import sys
from fontTools.ttLib import TTFont
font = TTFont(sys.argv[1])
chars = {g: chr(c) for c, g in font.getBestCmap().items()}
wanted = set(open(sys.argv[2]).read().split())
for lookup in font["GSUB"].table.LookupList.Lookup:
    for sub in lookup.SubTable:
        if sub.LookupType == 7:
            sub = sub.ExtSubTable
        if sub.LookupType != 4:
            continue
        for first in list(sub.ligatures):
            kept = [lig for lig in sub.ligatures[first]
                    if all(g in chars for g in [first] + lig.Component)
                    and "".join(chars[g] for g in [first] + lig.Component) in wanted]
            if kept:
                sub.ligatures[first] = kept
            else:
                del sub.ligatures[first]
font.save(sys.argv[3])
`;
  const pruned = join(work, "pruned.ttf");
  writeFileSync(join(work, "icons.txt"), icons.join("\n"));
  execFileSync("python3", ["-P", "-c", pruneLigatures, source, join(work, "icons.txt"), pruned], { stdio: "inherit" });

  const subset = join(work, "subset.woff2");
  execFileSync("python3", ["-P", "-m", "fontTools.subset", pruned,
    "--unicodes=U+0020-007E",
    "--layout-features=*",
    "--flavor=woff2",
    `--output-file=${subset}`,
  ], { stdio: "inherit" });

  // globals.css pins wght 400 / GRAD 0 / opsz 24 and only toggles FILL, so
  // flatten the other axes; they are most of the remaining bytes.
  execFileSync("python3", ["-P", "-m", "fontTools.varLib.instancer", subset,
    "wght=400", "GRAD=0", "opsz=24", "-o", output,
  ], { stdio: "inherit" });
} finally {
  rmSync(work, { recursive: true, force: true });
}

writeFileSync(manifest, `${icons.join("\n")}\n`);
const kb = (readFileSync(output).length / 1024).toFixed(1);
console.log(`[icon-font] ${icons.length} icons, ${kb} KB -> ${output}`);
