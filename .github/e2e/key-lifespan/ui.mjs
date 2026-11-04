// Opens both provider pages logged in, checks the lifespan label and saves
// full-page screenshots. Usage: node ui.mjs <baseUrl> <outDir>
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

async function open(providerId, activeName, shot) {
  const lifespanResp = page.waitForResponse((r) => r.url().includes(`/api/providers/lifespan?provider=${providerId}`), { timeout: 60000 });
  await page.goto(`/dashboard/providers/${providerId}`, { waitUntil: "domcontentloaded" });
  const resp = await lifespanResp;
  console.log(`ui: ${providerId} lifespan fetch -> ${resp.status()}`);
  await page.getByText(activeName, { exact: true }).first().waitFor({ state: "visible", timeout: 60000 });
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.screenshot({ path: `${outDir}/${shot}`, fullPage: true });
}

await open("openai-compatible-e2e-alpha", "alpha-active", "alpha-provider.png");
const labels = page.getByText(/% left/);
const n = await labels.count();
check("ui alpha: exactly one '% left' label", n === 1, String(n));
if (n >= 1) {
  const label = labels.first();
  check("ui alpha: label visible", await label.isVisible());
  const text = (await label.innerText()).trim();
  check("ui alpha: label reads ~58% left", /^~58% left/.test(text), text);
  const title = await label.getAttribute("title");
  console.log(`ui alpha: label title: ${JSON.stringify(title)}`);
  const row = await label.evaluate((el) => {
    let cur = el;
    while (cur && !(cur.classList && cur.classList.contains("group"))) cur = cur.parentElement;
    return cur ? cur.innerText : null;
  });
  check("ui alpha: label is in the alpha-active row", !!row && row.includes("alpha-active") && !row.includes("alpha-dead"), JSON.stringify(row));
  await label.scrollIntoViewIfNeeded();
  const box = await label.boundingBox();
  if (box) await page.screenshot({ path: `${outDir}/alpha-label-closeup.png`, clip: { x: 0, y: Math.max(0, box.y - 150), width: 1440, height: 300 } });
}

await open("openai-compatible-e2e-beta", "beta-active", "beta-provider.png");
const betaCount = await page.getByText(/% left/).count();
check("ui beta: no '% left' label", betaCount === 0, String(betaCount));

await browser.close();
if (failed) {
  console.log(`${failed} UI assertion(s) failed`);
  process.exit(1);
}
console.log("all UI assertions passed");
