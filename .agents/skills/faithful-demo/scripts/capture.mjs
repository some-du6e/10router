#!/usr/bin/env node
// Capture a running app page as the starting point for a faithful demo:
// rendered DOM (scripts removed), every stylesheet the page loaded, the fonts
// and images it uses, and full-page screenshots in light and dark.
//
//   node capture.mjs <url> <out-dir> [--login <login.mjs>] [--setup <setup.mjs>]
//                    [--name <page>] [--dark-class <class>] [--width 1440] [--height 900]
//
// --login takes a module whose default export is `async (page, origin) => {}`
// and signs in before the page loads; the session is reused for the capture.
// --setup takes a module whose default export is `async (page) => {}` and runs
// after the page loads: click open a modal, switch a tab, expand a row.
// --dark-class adds that class to <html> for the dark screenshot (Tailwind
// `dark`, etc.) on top of emulating prefers-color-scheme: dark.
// Playwright resolves from the current project first, then ~/.cache/faithful-demo.
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const USAGE = "usage: capture.mjs <url> <out-dir> [--login login.mjs] [--setup setup.mjs] [--name page] [--dark-class dark] [--width 1440] [--height 900]";
const FLAGS = new Set(["login", "setup", "name", "dark-class", "width", "height"]);
const flags = {};
const positional = [];
const argv = process.argv.slice(2).flatMap((a) => (a.startsWith("--") && a.includes("=") ? [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)] : [a]));
for (let i = 0; i < argv.length; i++) {
  if (!argv[i].startsWith("--")) { positional.push(argv[i]); continue; }
  const key = argv[i].slice(2);
  const value = argv[++i];
  if (!FLAGS.has(key) || value === undefined || value.startsWith("--")) {
    console.error(`bad flag --${key}\n${USAGE}`);
    process.exit(2);
  }
  flags[key] = value;
}
const [url, outDir] = positional;
if (!url || !outDir) {
  console.error(USAGE);
  process.exit(2);
}
const name = flags.name || "page";
const width = Number(flags.width || 1440);
const height = Number(flags.height || 900);

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
const fail = async (msg) => {
  console.error(msg);
  await browser.close();
  process.exit(1);
};
const context = await browser.newContext({ viewport: { width, height } });
const page = await context.newPage();

// Local copies of fonts and images, keyed by absolute URL without its #hash.
const saved = new Map();
const used = new Set();
const EXT = { "image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp", "image/avif": ".avif", "image/svg+xml": ".svg", "image/x-icon": ".ico", "font/woff2": ".woff2", "font/woff": ".woff", "font/ttf": ".ttf", "font/otf": ".otf" };
function localName(u, contentType) {
  // Decode and sanitize, so "my%20pic.png" is saved and referenced as "my-pic.png".
  let base = path.basename(decodeURIComponent(u.pathname)).replace(/[^\w.-]+/g, "-") || "asset";
  if (!path.extname(base)) base += EXT[contentType.split(";")[0].trim()] || "";
  let file = base;
  for (let n = 1; used.has(file); n++) file = `${n}-${base}`;
  used.add(file);
  return file;
}
async function save(absUrl, body, contentType = "") {
  const key = absUrl.split("#")[0];
  if (saved.has(key)) return;
  const u = new URL(key);
  if (!/^https?:$/.test(u.protocol)) return;
  const file = localName(u, contentType);
  saved.set(key, `assets/${file}`);
  await writeFile(path.join(assetsDir, file), body);
}

// Every response handler is awaited before the rewrite, so no asset lands late.
const pending = [];
page.on("response", (res) => {
  const type = res.request().resourceType();
  const ct = res.headers()["content-type"] || "";
  if (!(type === "font" || type === "image" || /font|image\//.test(ct)) || !res.ok()) return;
  pending.push(res.body().then((body) => save(res.url(), body, ct)).catch(() => {}));
});

if (flags.login) {
  try {
    const login = (await import(pathToFileURL(path.resolve(flags.login)).href)).default;
    await login(page, new URL(url).origin);
  } catch (e) {
    await fail(`login script failed: ${e.message}`);
  }
}
const res = await page.goto(url, { waitUntil: "networkidle" });
if (!res?.ok()) await fail(`${url} returned ${res?.status() ?? "no response"}`);
await page.evaluate(() => document.fonts?.ready);
await page.waitForTimeout(500);
const strip = (u) => { const x = new URL(u); return x.origin + x.pathname.replace(/\/$/, ""); };
if (strip(page.url()) !== strip(url)) await fail(`${url} redirected to ${page.url()}. Is the login working?`);
if (flags.setup) {
  try {
    const setup = (await import(pathToFileURL(path.resolve(flags.setup)).href)).default;
    await setup(page);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(300);
  } catch (e) {
    await fail(`setup script failed: ${e.message}`);
  }
}

// Stylesheets as the browser sees them, including @font-face from font
// loaders. @import is inlined in place, media attributes become @media
// blocks, and url() is resolved against its own sheet.
const chunks = await page.evaluate(() => {
  const out = [];
  const walk = (sheet, media) => {
    if (sheet.disabled) return;
    const m = sheet.media?.mediaText;
    const stack = m && m !== "all" ? [...media, m] : media;
    let rules;
    try {
      rules = [...sheet.cssRules];
    } catch {
      out.push({ href: sheet.href, media: stack });
      return;
    }
    const base = sheet.href || location.href;
    let text = "";
    for (const r of rules) {
      if (r instanceof CSSImportRule) {
        if (text) out.push({ text, base, media: stack });
        text = "";
        if (r.styleSheet) walk(r.styleSheet, stack);
      } else {
        text += r.cssText + "\n";
      }
    }
    if (text) out.push({ text, base, media: stack });
  };
  for (const sheet of document.styleSheets) walk(sheet, []);
  return out;
});
const absolutize = (text, base) => text.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (m, q, u) =>
  u.startsWith("data:") || u.startsWith("#") ? m : `url("${new URL(u, base).href}")`);
let css = "";
for (const c of chunks) {
  let text = c.text;
  if (text === undefined) {
    // Cross-origin sheet (Google Fonts, a CDN): the page can't read it, Node can.
    const r = await page.request.get(c.href).catch(() => null);
    text = r?.ok() ? await r.text() : `/* could not fetch ${c.href} */`;
  }
  text = `/* ${c.href || c.base} */\n` + absolutize(text, c.href || c.base);
  for (const m of [...c.media].reverse()) text = `@media ${m} {\n${text}\n}`;
  css += text + "\n\n";
}

// Rendered DOM with scripts and dev overlays removed, every asset reference
// resolved to an absolute URL so the rewrite below can find it.
const { html, refs } = await page.evaluate((cssHref) => {
  const refs = new Set();
  const abs = (u) => {
    if (!u || /^(data:|#|javascript:|mailto:|blob:)/.test(u)) return u;
    try { const a = new URL(u, document.baseURI).href; refs.add(a); return a; } catch { return u; }
  };
  const absCss = (t) => t.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (m, q, u) => (u.startsWith("data:") || u.startsWith("#") ? m : `url("${abs(u)}")`));
  const doc = document.documentElement.cloneNode(true);
  doc.querySelectorAll('script, link[rel="preload"], link[rel="modulepreload"], link[rel="stylesheet"], style, nextjs-portal, vite-error-overlay').forEach((n) => n.remove());
  for (const el of doc.querySelectorAll("[src], [poster], link[rel*='icon'], image[href]")) {
    for (const a of ["src", "poster", "href"]) if (el.hasAttribute(a)) el.setAttribute(a, abs(el.getAttribute(a)));
  }
  for (const el of doc.querySelectorAll("[srcset]")) {
    el.setAttribute("srcset", el.getAttribute("srcset").split(/,\s+/).map((c) => {
      const [u, ...d] = c.trim().split(/\s+/);
      return [abs(u), ...d].join(" ");
    }).join(", "));
  }
  for (const el of doc.querySelectorAll("[style]")) el.setAttribute("style", absCss(el.getAttribute("style")));
  // Link the captured stylesheet so the file opens styled straight from disk.
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = cssHref;
  doc.querySelector("head")?.appendChild(link);
  return { html: "<!doctype html>\n" + doc.outerHTML, refs: [...refs] };
}, `${name}.css`);

await page.screenshot({ path: path.join(outDir, `${name}-light.png`), fullPage: true });
await page.emulateMedia({ colorScheme: "dark" });
if (flags["dark-class"]) await page.evaluate((c) => document.documentElement.classList.add(c), flags["dark-class"]);
await page.waitForTimeout(400);
await page.screenshot({ path: path.join(outDir, `${name}-dark.png`), fullPage: true });
await Promise.all(pending);

// Fetch references the page never requested (unused unicode ranges, 2x srcset
// candidates, hover images) so the capture works after the dev server stops.
for (const u of [...refs, ...[...css.matchAll(/url\("([^"]+)"\)/g)].map((m) => m[1])]) {
  const key = u.split("#")[0];
  if (saved.has(key) || !/^https?:/.test(key)) continue;
  const r = await page.request.get(key).catch(() => null);
  if (r?.ok()) await save(key, await r.body(), r.headers()["content-type"] || "");
}
await browser.close();

// Longest URLs first, and only at a URL boundary, so one saved URL never
// rewrites inside another. outerHTML writes & as &amp; and " as &quot;.
const rewrite = (text) => {
  let out = text;
  for (const [abs, local] of [...saved].sort((a, b) => b[0].length - a[0].length)) {
    for (const form of new Set([abs, abs.replaceAll("&", "&amp;")])) {
      const esc = form.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      out = out.replace(new RegExp(`(^|["'(\\s,=;])${esc}(?=[#"')\\s,]|&quot;|$)`, "g"), (m, pre) => pre + local);
    }
  }
  return out;
};

await writeFile(path.join(outDir, `${name}.html`), rewrite(html));
await writeFile(path.join(outDir, `${name}.css`), rewrite(css));
console.log(`Captured ${url}
  ${name}.html  rendered DOM, scripts removed, links ${name}.css
  ${name}.css   ${css.length} chars of loaded stylesheets
  assets/       ${saved.size} fonts and images
  ${name}-light.png, ${name}-dark.png`);
