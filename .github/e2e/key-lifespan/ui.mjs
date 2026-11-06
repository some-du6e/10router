// Opens the provider pages logged in, checks the lifespan label and saves
// full-page screenshots. Usage: node ui.mjs <baseUrl> <outDir>
//   custom endpoint page (CustomEndpointPage.tsx): openai-compatible-e2e-alpha / -beta
//   built-in provider page (ConnectionRow.js):      openai
//   media provider page (ConnectionsCard.js):        embedding/voyage-ai
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const [base, outDir] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });
const password = process.env.INITIAL_PASSWORD;

let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) failed++;
};

const browser = await chromium.launch();
// Clipboard access, for the real pastes in the Add key dialog checks.
const context = await browser.newContext({ baseURL: base, viewport: { width: 1440, height: 1000 }, permissions: ["clipboard-read", "clipboard-write"] });
const login = await context.request.post("/api/auth/login", { data: { password } });
check("ui: login", login.ok(), String(login.status()));
const page = await context.newPage();
page.on("console", (m) => { if (m.type() === "error") console.log(`[browser] ${m.text()}`); });

async function open(pagePath, providerId, activeName, shot) {
  const lifespanResp = page.waitForResponse((r) => r.url().includes(`/api/providers/lifespan?provider=${providerId}`), { timeout: 60000 });
  await page.goto(pagePath, { waitUntil: "domcontentloaded" });
  const resp = await lifespanResp;
  console.log(`ui: ${pagePath} lifespan fetch -> ${resp.status()}`);
  await page.getByText(activeName, { exact: true }).first().waitFor({ state: "visible", timeout: 60000 });
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.screenshot({ path: `${outDir}/${shot}.png`, fullPage: true });
}

// The lifespan label is the span whose tooltip starts "Used ".
const labels = () => page.locator('span[title^="Used "]');

async function expectLabel(tag, { activeName, deadName, text }) {
  const n = await labels().count();
  check(`ui ${tag}: exactly one lifespan label`, n === 1, String(n));
  if (n < 1) return;
  const label = labels().first();
  check(`ui ${tag}: label visible`, await label.isVisible());
  const got = (await label.innerText()).trim();
  check(`ui ${tag}: label reads ${text}`, got.startsWith(text), got);
  console.log(`ui ${tag}: label title: ${JSON.stringify(await label.getAttribute("title"))}`);
  // Smallest ancestor that names a key: it must be the active key, not a dead one.
  const row = await label.evaluate((el, name) => {
    let cur = el;
    while (cur && !cur.innerText.includes(name)) cur = cur.parentElement;
    return cur ? cur.innerText : null;
  }, activeName);
  check(`ui ${tag}: label is in the ${activeName} row`, !!row && !row.includes(deadName), JSON.stringify(row));
  await label.scrollIntoViewIfNeeded();
  const box = await label.boundingBox();
  if (box) await page.screenshot({ path: `${outDir}/${tag}-label-closeup.png`, clip: { x: 0, y: Math.max(0, box.y - 150), width: 1440, height: 300 } });
}

await open("/dashboard/providers/openai-compatible-e2e-alpha", "openai-compatible-e2e-alpha", "alpha-active", "alpha-provider");
await expectLabel("alpha", { activeName: "alpha-active", deadName: "alpha-dead", text: "~58% left" });

await open("/dashboard/providers/openai-compatible-e2e-beta", "openai-compatible-e2e-beta", "beta-active", "beta-provider");
const betaCount = await labels().count();
check("ui beta: no lifespan label", betaCount === 0, String(betaCount));

await open("/dashboard/providers/openai", "openai", "openai-active", "openai-provider");
await expectLabel("openai", { activeName: "openai-active", deadName: "openai-dead", text: "~80% left" });

await open("/dashboard/media-providers/embedding/voyage-ai", "voyage-ai", "voyage-active", "voyage-media-provider");
await expectLabel("voyage", { activeName: "voyage-active", deadName: "voyage-dead", text: "~50% left" });

// Add key dialog (AddApiKeyModal.js): a pasted Claude Code config fills the
// key and, when its URL isn't the endpoint's own, the key's endpoint URL.
const keyField = () => page.getByPlaceholder("Paste a key");
async function openAddKey(pagePath, providerId, activeName, shot) {
  await open(pagePath, providerId, activeName, shot);
  await page.getByRole("button", { name: "Add key" }).first().click();
  await keyField().waitFor({ state: "visible", timeout: 30000 });
}

// A real paste: the clipboard and Ctrl+V, so the browser's own insert (which
// drops line breaks) runs unless the dialog cancels it.
async function paste(field, text) {
  await page.evaluate((t) => navigator.clipboard.writeText(t), text);
  await field.focus();
  await field.press("ControlOrMeta+V");
}
const hintText = (text) => page.getByText(text, { exact: true });
async function hintShown(text) {
  await hintText(text).waitFor({ state: "visible", timeout: 10000 }).catch(() => {});
  return hintText(text).isVisible();
}
const filledAny = () => page.getByText("Filled from pasted config", { exact: false });
const urlButton = () => page.getByRole("button", { name: "Use a different endpoint URL for this key" });

const snippet = JSON.stringify({
  env: {
    ANTHROPIC_BASE_URL: "https://example.com/api",
    ANTHROPIC_AUTH_TOKEN: "sk-xxx",
    CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1",
  },
}, null, 2);
await openAddKey("/dashboard/providers/openai-compatible-e2e-beta", "openai-compatible-e2e-beta", "beta-active", "beta-before-paste");
await paste(keyField(), snippet);
const pasteHint = "Filled from pasted config: key, endpoint URL. Ignored 1 other variable.";
check("paste: hint shown", await hintShown(pasteHint));
check("paste: key field holds only the key", (await keyField().inputValue()) === "sk-xxx");
const keyUrlField = page.getByPlaceholder("https://e2eb.e2e.invalid/v1");
const keyUrlShown = await keyUrlField.isVisible();
check("paste: per-key URL revealed", keyUrlShown);
if (keyUrlShown) check("paste: per-key URL gets /v1", (await keyUrlField.inputValue()) === "https://example.com/api/v1", await keyUrlField.inputValue());
await page.screenshot({ path: `${outDir}/paste-config-filled.png`, fullPage: true });
const saved = page.waitForResponse((r) => r.url().endsWith("/api/providers") && r.request().method() === "POST", { timeout: 30000 });
await page.locator('form button[type="submit"]').click();
check("paste: key saved", (await saved).ok());
const list = await (await context.request.get("/api/providers")).json();
const added = (list.connections || []).filter((c) => c.provider === "openai-compatible-e2e-beta" && c.providerSpecificData?.ownBaseUrl);
check("paste: saved key has its own URL", added.length === 1 && added[0].providerSpecificData.baseUrl === "https://example.com/api/v1",
  JSON.stringify(added.map((c) => c.providerSpecificData?.baseUrl)));

await openAddKey("/dashboard/providers/openai-compatible-e2e-alpha", "openai-compatible-e2e-alpha", "alpha-active", "alpha-before-paste");
const alphaUrlField = page.getByPlaceholder("https://e2ea.e2e.invalid/v1");

// Not a config (the last line is a command): pasted as text, like any key,
// and the run-together text isn't read as a config afterwards.
await paste(keyField(), "ANTHROPIC_AUTH_TOKEN=sk-xxx\nclaude");
check("rejected paste: inserted as text", (await keyField().inputValue()) === "ANTHROPIC_AUTH_TOKEN=sk-xxxclaude", await keyField().inputValue());
check("rejected paste: no hint", (await filledAny().count()) === 0);

// The endpoint's own URL, put in at once (a drop, or a browser that didn't fire paste): no per-key URL.
await keyField().fill(JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://e2ea.e2e.invalid/", ANTHROPIC_AUTH_TOKEN: "sk-xxx" } }));
const sameHint = "Filled from pasted config: key. Its URL is this endpoint's own, so the key uses that.";
check("paste same URL: hint shown", await hintShown(sameHint));
check("paste same URL: key filled", (await keyField().inputValue()) === "sk-xxx");
check("paste same URL: per-key URL stays hidden", await urlButton().isVisible());
await page.screenshot({ path: `${outDir}/paste-config-same-url.png`, fullPage: true });

// Both APIs' variables on an OpenAI-compatible endpoint: the OpenAI ones win.
await paste(keyField(), "ANTHROPIC_AUTH_TOKEN=sk-a\nANTHROPIC_BASE_URL=https://a.example.com\nOPENAI_API_KEY=sk-o\nOPENAI_BASE_URL=https://o.example.com/v1");
check("paste both APIs: OpenAI key", (await keyField().inputValue()) === "sk-o");
check("paste both APIs: OpenAI URL", (await alphaUrlField.isVisible()) && (await alphaUrlField.inputValue()) === "https://o.example.com/v1");

// Then the endpoint's own URL: the per-key URL set a moment ago is cleared.
await paste(keyField(), JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://e2ea.e2e.invalid/", ANTHROPIC_AUTH_TOKEN: "sk-xxx" } }));
check("paste same URL after another: hint shown", await hintShown(sameHint));
check("paste same URL after another: per-key URL cleared", (await alphaUrlField.inputValue()) === "", await alphaUrlField.inputValue());

// A plain key is left alone.
await keyField().fill("sk-plain={xxx}==");
check("plain key: unchanged", (await keyField().inputValue()) === "sk-plain={xxx}==");
check("plain key: hint cleared", (await filledAny().count()) === 0);

// A URL-only paste keeps the key already entered and fills the per-key URL.
await paste(keyField(), "export ANTHROPIC_BASE_URL=https://example.com/api\n");
check("URL-only paste: hint shown", await hintShown("Filled from pasted config: endpoint URL. It has no key, so the key already entered stays."));
check("URL-only paste: key kept", (await keyField().inputValue()) === "sk-plain={xxx}==");
check("URL-only paste: per-key URL filled", (await alphaUrlField.isVisible()) && (await alphaUrlField.inputValue()) === "https://example.com/api/v1");

// Built-in provider (no per-key URL): only the key is taken.
await open("/dashboard/providers/openai", "openai", "openai-active", "openai-before-paste");
await page.getByRole("button", { name: /^(add\s*)?Add$/ }).first().click();
const builtinKey = page.locator(".fixed.inset-0.z-50 input[data-lpignore]").first();
await builtinKey.waitFor({ state: "visible", timeout: 30000 });
await paste(builtinKey, snippet);
check("built-in paste: hint shown", await hintShown("Filled from pasted config: key. Ignored 2 other variables."));
check("built-in paste: key field holds only the key", (await builtinKey.inputValue()) === "sk-xxx");
await page.screenshot({ path: `${outDir}/paste-config-built-in.png`, fullPage: true });

await browser.close();
if (failed) {
  console.log(`${failed} UI assertion(s) failed`);
  process.exit(1);
}
console.log("all UI assertions passed");
