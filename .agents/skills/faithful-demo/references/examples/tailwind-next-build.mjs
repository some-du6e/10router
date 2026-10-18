// Worked example from the 10router add-endpoint demo (mockups/provider-setup).
// Page-specific: the slot selector, font variable class, and grid markup only fit that capture.
// Builds the demo from the real 10router shell (captured/), the app's own
// globals.css compiled by its Tailwind toolchain, and src/ for the new UI.
// Run from mockups/provider-setup; resolves postcss/tailwind from the repo root.
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

const here = process.cwd();
const root = path.resolve(here, "../..");
const require = createRequire(path.join(root, "package.json"));
const postcss = require("postcss");
const tailwind = require("@tailwindcss/postcss");

await rm("dist", { recursive: true, force: true });
await mkdir("dist/assets", { recursive: true });

// Compile the app's real stylesheet, adding this demo's sources to the scan so
// any class used only by the new UI still gets generated.
const globalsPath = path.join(root, "src/app/globals.css");
const globals = (await readFile(globalsPath, "utf8")) +
  `\n@source "${path.join(here, "src")}";\n`;
const { css } = await postcss([tailwind({ base: root })]).process(globals, { from: globalsPath });

// Inter @font-face rules come from next/font, not globals.css: lift them from the capture.
const captured = await readFile("captured/app.css", "utf8");
const interFaces = (captured.match(/@font-face\s*\{[^}]*'Inter[^}]*\}/g) || []).join("\n");
const fontVars = ".__variable_d8ebd1{--font-inter:'Inter','Inter Fallback'}";

const fixUrls = (s) => s
  .replace(/url\(["']?[^)"']*material-symbols-outlined\.woff2["']?\)/g, "url(assets/material-symbols-outlined.ec1fa111.woff2)")
  .replace(/url\(\/_next\/static\/media\/([^)]+)\)/g, "url(assets/$1)");

await writeFile("dist/app.css", fixUrls(interFaces + "\n" + fontVars + "\n" + css));
await cp("captured/assets", "dist/assets", { recursive: true });
await cp("captured/providers", "dist/providers", { recursive: true });
// Only icons the captured grid or demo actually reference.
for (const f of ["openrouter.png"]) await cp(path.join(root, "public/providers", f), `dist/providers/${f}`);

// Shell: real sidebar + header from the capture, content slot swapped for the demo.
const shell = await readFile("captured/providers.html", "utf8");
// Fail loudly when a marker is missing from a new capture instead of slicing garbage.
const find = (hay, needle, from = "captured/providers.html", last = false) => {
  const at = last ? hay.lastIndexOf(needle) : hay.indexOf(needle);
  if (at < 0) throw new Error(`${needle} not found in ${from}; update this marker for the new capture`);
  return at;
};
const open = '<div class="max-w-7xl mx-auto">';
const start = find(shell, open) + open.length;
const end = find(shell, "</main>", undefined, true);
// Content ends at the closing of max-w-7xl + scroll container before </main>.
const closing = shell.slice(start, end);
const tailIdx = find(closing, "</div></div>", "the content slot", true);
const page = await readFile("src/index.html", "utf8");
const html = shell.slice(0, start) + '<div id="demo-root"></div>' + closing.slice(tailIdx) + shell.slice(end)
  .replace("</body>", `${page}</body>`);
const finalHtml = html
  .replace("<head>", '<head><link rel="stylesheet" href="app.css"><link rel="stylesheet" href="demo.css">')
  ;
await writeFile("dist/index.html", finalHtml);
await cp("src/app.js", "dist/app.js");
await cp("src/demo.css", "dist/demo.css");
console.log("Built dist/ from the captured 10router shell, compiled globals.css and src/.");

// Real vendor cards from the capture, so the grid below custom endpoints is the actual page.
const gridOpen = '<div class="grid grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-4 lg:grid-cols-3 xl:grid-cols-4">';
const gStart = find(shell, gridOpen) + gridOpen.length;
let depth = 1, i = gStart;
const tag = /<(\/?)div\b[^>]*>/g;
tag.lastIndex = gStart;
let m;
while ((m = tag.exec(shell))) { depth += m[1] ? -1 : 1; if (depth === 0) { i = m.index; break; } }
await writeFile("dist/vendor-grid.html", shell.slice(gStart, i).replace(/href="\/dashboard[^"]*"/g, 'href="#"'));
