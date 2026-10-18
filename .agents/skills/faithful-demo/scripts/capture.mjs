#!/usr/bin/env node
// Capture a running app page as the starting point for a faithful demo:
// rendered DOM (scripts removed), every stylesheet the page loaded, the fonts
// and images it fetched, and full-page screenshots in light and dark.
//
//   node capture.mjs <url> <out-dir> [--login <login.mjs>] [--name <page>]
//                    [--dark-class <class>] [--width 1440] [--height 900]
//
// --login points at a module exporting `default async (page, baseUrl) => {}`
// that signs in. It runs once; the session is reused for the capture.
// --dark-class adds that class to <html> for the dark screenshot (Tailwind
// `dark`, etc.) on top of emulating prefers-color-scheme: dark.
// Playwright resolves from the current project first, then ~/.cache/faithful-demo.
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
}
const [url, outDir] = process.argv.slice(2).filter((a, i, all) => !a.startsWith("--") && !all[i - 1]?.startsWith("--"));
if (!url || !outDir) {
  console.error("usage: capture.mjs <url> <out-dir> [--login login.mjs] [--name page] [--dark-class dark]");
  process.exit(2);
}
const name = arg("name", "page");
const width = Number(arg("width", 1440));
const height = Number(arg("height", 900));
const darkClass = arg("dark-class");
const loginScript = arg("login");

function loadPlaywright() {
  for (const base of [process.cwd(), path.join(homedir(), ".cache/faithful-demo")]) {
    try {
      return createRequire(path.join(base, "package.json"))("playwright");
    } catch {}
  }
  console.error("playwright not found. Install it once with:\n  mkdir -p ~/.cache/faithful-demo && cd ~/.cache/faithful-demo && npm init -y && npm i playwright && npx playwright install chromium");
  process.exit(1);
}
const { chromium } = loadPlaywright();

const assetsDir = path.join(outDir, "assets");
await mkdir(assetsDir, { recursive: true });

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width, height } });
const page = await context.newPage();

// Keep every font and image the page fetches, keyed by URL, under readable names.
const saved = new Map();
const used = new Set();
page.on("response", async (res) => {
  const type = res.request().resourceType();
  const ct = res.headers()["content-type"] || "";
  if (!(type === "font" || type === "image" || /font|image\//.test(ct))) return;
  try {
    const body = await res.body();
    const u = new URL(res.url());
    if (u.protocol === "data:") return;
    let file = path.basename(u.pathname) || "asset";
    for (let n = 1; used.has(file); n++) file = `${n}-${path.basename(u.pathname)}`;
    used.add(file);
    await writeFile(path.join(assetsDir, file), body);
    saved.set(res.url(), `assets/${file}`);
  } catch {}
});

if (loginScript) {
  const login = (await import(pathToFileURL(path.resolve(loginScript)).href)).default;
  await login(page, new URL(url).origin);
}
await page.goto(url, { waitUntil: "networkidle" });
await page.evaluate(() => document.fonts?.ready);
await page.waitForTimeout(500);

// Stylesheets as the browser sees them, including @font-face from font loaders.
const css = await page.evaluate(() => {
  const out = [];
  for (const sheet of document.styleSheets) {
    try {
      const base = sheet.href || location.href;
      const text = [...sheet.cssRules].map((r) => r.cssText).join("\n");
      // Resolve url() against the sheet so relative font paths survive the move.
      const abs = text.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (m, q, u) =>
        u.startsWith("data:") ? m : `url("${new URL(u, base).href}")`);
      out.push(`/* ${sheet.href || "inline <style>"} */\n` + abs);
    } catch {
      out.push(`/* cross-origin, not readable: ${sheet.href} */`);
    }
  }
  return out.join("\n\n");
});

// Rendered DOM with scripts, preloads and Next/Vite dev artifacts removed.
const html = await page.evaluate(() => {
  const doc = document.documentElement.cloneNode(true);
  doc.querySelectorAll('script, link[rel="preload"], link[rel="modulepreload"], link[rel="stylesheet"], style, nextjs-portal, vite-error-overlay').forEach((n) => n.remove());
  return "<!doctype html>\n" + doc.outerHTML;
});

// Fetch url() targets the page never requested (unused unicode ranges, hover
// images) so the capture keeps working after the dev server stops.
const origin = new URL(url).origin;
for (const [, u] of css.matchAll(/url\("([^"]+)"\)/g)) {
  if (saved.has(u) || !u.startsWith(origin)) continue;
  try {
    const res = await page.request.get(u);
    if (!res.ok()) continue;
    let file = path.basename(new URL(u).pathname) || "asset";
    for (let n = 1; used.has(file); n++) file = `${n}-${path.basename(new URL(u).pathname)}`;
    used.add(file);
    await writeFile(path.join(assetsDir, file), await res.body());
    saved.set(u, `assets/${file}`);
  } catch {}
}

const rewrite = (text) => {
  let out = text;
  for (const [abs, local] of saved) {
    const u = new URL(abs);
    for (const form of [abs, u.pathname + u.search, u.pathname]) out = out.split(form).join(local);
  }
  return out;
};

await writeFile(path.join(outDir, `${name}.html`), rewrite(html));
await writeFile(path.join(outDir, `${name}.css`), rewrite(css));
await page.screenshot({ path: path.join(outDir, `${name}-light.png`), fullPage: true });

await page.emulateMedia({ colorScheme: "dark" });
if (darkClass) await page.evaluate((c) => document.documentElement.classList.add(c), darkClass);
await page.waitForTimeout(400);
await page.screenshot({ path: path.join(outDir, `${name}-dark.png`), fullPage: true });

await browser.close();
console.log(`Captured ${url}
  ${name}.html  rendered DOM, scripts removed
  ${name}.css   ${css.length} chars of loaded stylesheets
  assets/       ${saved.size} fonts and images
  ${name}-light.png, ${name}-dark.png`);
