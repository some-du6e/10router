// Worked example from the 10router add-endpoint demo (mockups/provider-setup).
// Page-specific: the slot marker and grid markup only fit the providers page.
//
// Builds dist/ from the real 10router shell (captured/, made with
// `capture.mjs ... --name providers`), the app's own globals.css compiled by
// its Tailwind toolchain, and src/ for the new UI. Run from mockups/<feature>;
// resolves postcss/tailwind from the repo root.
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

const here = process.cwd();
const root = path.resolve(here, "../..");
const require = createRequire(path.join(root, "package.json"));
const postcss = require("postcss");
const tailwind = require("@tailwindcss/postcss");

await rm("dist", { recursive: true, force: true });
await mkdir("dist", { recursive: true });

// Compile the app's real stylesheet, adding this demo's sources to the scan so
// any class used only by the new UI still gets generated.
const globalsPath = path.join(root, "src/app/globals.css");
// Forward slashes and escaped quotes: a raw Windows path is read as CSS escapes.
const demoSrc = path.join(here, "src").split(path.sep).join("/").replace(/"/g, '\\"');
const globals = (await readFile(globalsPath, "utf8")) + `\n@source "${demoSrc}";\n`;
const { css } = await postcss([tailwind({ base: root })]).process(globals, { from: globalsPath });

// next/font's @font-face rules and its variable class (the one on <body>)
// aren't in globals.css. Lift both from the capture rather than retyping them.
const captured = await readFile("captured/providers.css", "utf8");
const shell = await readFile("captured/providers.html", "utf8");
const faces = (captured.match(/@font-face\s*\{[^}]*\}/g) || []).join("\n");
const bodyClasses = (shell.match(/<body class="([^"]*)"/) || [])[1]?.split(/\s+/) || [];
const fontVars = bodyClasses
  .flatMap((c) => captured.match(new RegExp(`\\.${c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{[^}]*\\}`, "g")) || [])
  .join("\n");

await writeFile("dist/app.css", faces + "\n" + fontVars + "\n" + css);
await cp("captured/assets", "dist/assets", { recursive: true });
// Icons the demo adds that the captured page never loaded.
await mkdir("dist/providers", { recursive: true });
for (const f of ["openrouter.png"]) await cp(path.join(root, "public/providers", f), `dist/providers/${f}`);

// Fail loudly when a marker is missing from a new capture instead of slicing garbage.
const find = (hay, needle, from = "captured/providers.html", last = false) => {
  const at = last ? hay.lastIndexOf(needle) : hay.indexOf(needle);
  if (at < 0) throw new Error(`${needle} not found in ${from}; update this marker for the new capture`);
  return at;
};

// Shell: real sidebar + header from the capture, content slot swapped for the demo.
const open = '<div class="max-w-7xl mx-auto">';
const start = find(shell, open) + open.length;
const end = find(shell, "</main>", undefined, true);
// Content ends at the closing of max-w-7xl + scroll container before </main>.
const closing = shell.slice(start, end);
const tailIdx = find(closing, "</div></div>", "the content slot", true);
const page = await readFile("src/index.html", "utf8");
const html = (shell.slice(0, start) + '<div id="demo-root"></div>' + closing.slice(tailIdx) + shell.slice(end))
  // The capture links providers.css; the build ships app.css instead.
  .replace('<link rel="stylesheet" href="providers.css">', "")
  .replace("<head>", '<head><link rel="stylesheet" href="app.css"><link rel="stylesheet" href="demo.css">')
  .replace("</body>", `${page}</body>`)
  // Sidebar links lead to pages this demo doesn't cover.
  .replace(/href="\/dashboard[^"]*"/g, 'href="#"');
await writeFile("dist/index.html", html);
await cp("src/app.js", "dist/app.js");
await cp("src/demo.css", "dist/demo.css");

// Real vendor cards from the capture, so the grid below custom endpoints is the actual page.
const gridOpen = '<div class="grid grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-4 lg:grid-cols-3 xl:grid-cols-4">';
const gStart = find(shell, gridOpen) + gridOpen.length;
let depth = 1, i = gStart;
const tag = /<(\/?)div\b[^>]*>/g;
tag.lastIndex = gStart;
let m;
while ((m = tag.exec(shell))) { depth += m[1] ? -1 : 1; if (depth === 0) { i = m.index; break; } }
await writeFile("dist/vendor-grid.html", shell.slice(gStart, i).replace(/href="\/dashboard[^"]*"/g, 'href="#"'));
console.log("Built dist/ from the captured 10router shell, compiled globals.css and src/.");
