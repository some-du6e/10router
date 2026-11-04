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
const context = await browser.newContext({ baseURL: base, viewport: { width: 1440, height: 1000 } });
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

await browser.close();
if (failed) {
  console.log(`${failed} UI assertion(s) failed`);
  process.exit(1);
}
console.log("all UI assertions passed");
