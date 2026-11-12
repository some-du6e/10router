// End-to-end check of management keys on a built, running 10router: the
// management API through the real proxy, the boundary against the dashboard
// APIs and /v1, and the dashboard section. Saves screenshots.
// Usage: node run.mjs <baseUrl> <outDir>   (INITIAL_PASSWORD in the env)
import { chromium, request as pwRequest } from "playwright";
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
const context = await browser.newContext({ baseURL: base, viewport: { width: 1440, height: 1100 }, permissions: ["clipboard-read", "clipboard-write"] });
const login = await context.request.post("/api/auth/login", { data: { password } });
check("login", login.ok(), String(login.status()));

// The dashboard (session cookie) creates the management keys.
async function makeKey(name, scopes) {
  const res = await context.request.post("/api/management-keys", { data: { name, scopes } });
  const body = await res.json();
  check(`dashboard creates "${name}"`, res.status() === 201 && body.secret?.startsWith("10r-mgmt-"), String(res.status()));
  return body.secret;
}
const clientMgmt = await makeKey("e2e client keys", { clientKeys: { enabled: true, providers: ["openai"], maxBudgetUsd: 10 } });
const providerMgmt = await makeKey("e2e provider keys", { providerKeys: { enabled: true, providers: ["openai"] } });

// A caller with no cookie, as a script holding a management key would be.
const anon = await pwRequest.newContext({ baseURL: base });
const bodies = [];
async function call(method, path, { token, data, headers = {} } = {}) {
  const res = await anon.fetch(path, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    data,
  });
  const text = await res.text();
  bodies.push({ path, status: res.status(), text });
  return { status: res.status(), text, json: (() => { try { return JSON.parse(text); } catch { return null; } })() };
}

const me = await call("GET", "/api/management/v1/me", { token: clientMgmt });
check("GET /me with the key", me.status === 200 && me.json?.managementKey?.name === "e2e client keys", String(me.status));
check("GET /me without a key", (await call("GET", "/api/management/v1/me")).status === 401);
const withCookie = await context.request.get("/api/management/v1/me");
check("GET /me with only a dashboard session", withCookie.status() === 401, String(withCookie.status()));

const created = await call("POST", "/api/management/v1/client-keys", { token: clientMgmt, data: { name: "e2e team", allowedModels: ["openai/gpt-5"], budgetUsd: 10 } });
check("create an in-scope client key", created.status === 201 && created.json?.key?.startsWith("sk-"), String(created.status));
const clientKey = created.json?.key;
const outOfScope = await call("POST", "/api/management/v1/client-keys", { token: clientMgmt, data: { name: "x", allowedModels: ["anthropic/claude-opus-5-5"], budgetUsd: 1 } });
check("refuse an out-of-scope client key", outOfScope.status === 403, String(outOfScope.status));
const overCap = await call("POST", "/api/management/v1/client-keys", { token: clientMgmt, data: { name: "x", allowedModels: ["openai/gpt-5"], budgetUsd: 11 } });
check("refuse a budget over the cap", overCap.status === 403, String(overCap.status));
const listed = await call("GET", "/api/management/v1/client-keys", { token: clientMgmt });
check("list shows the key, without the full key", listed.status === 200 && listed.json?.clientKeys?.length === 1 && !listed.text.includes(clientKey));

for (const path of ["/api/keys", "/api/providers", "/api/settings", "/api/management-keys", "/api/usage/history"]) {
  const r = await call("GET", path, { token: clientMgmt });
  check(`management key refused on ${path}`, r.status === 401 || r.status === 403, String(r.status));
}
const inference = await call("POST", "/v1/chat/completions", { token: clientMgmt, data: { model: "openai/gpt-5", messages: [{ role: "user", content: "hi" }] } });
check("management key refused on /v1 (even from loopback), with the refusal message", inference.status === 401 && /management key can't be used for inference/.test(inference.text), `${inference.status} ${inference.text.slice(0, 120)}`);
const models = await call("GET", "/v1/models", { headers: { "x-api-key": clientMgmt } });
check("management key refused on /v1/models via x-api-key", models.status === 401, String(models.status));
const clientOnMgmt = await call("GET", "/api/management/v1/me", { token: clientKey });
check("client key refused on the management API", clientOnMgmt.status === 401, String(clientOnMgmt.status));

const fakeUpstream = `sk-e2e-not-a-real-key-${Date.now()}`;
const outside = await call("POST", "/api/management/v1/provider-keys", { token: providerMgmt, data: { provider: "anthropic", apiKey: fakeUpstream } });
check("refuse a provider key outside the scope", outside.status === 403, String(outside.status));
const refused = await call("POST", "/api/management/v1/provider-keys", { token: providerMgmt, data: { provider: "openai", apiKey: fakeUpstream, name: "e2e refused" } });
check("a key the provider refuses is not added", refused.status === 422, String(refused.status));
const pool = await context.request.get("/api/providers");
check("the refused key is not in the pool", !(await pool.text()).includes("e2e refused"));
const noHosts = await call("POST", "/api/management/v1/provider-keys", { token: providerMgmt, data: { provider: "openai", apiKey: fakeUpstream, baseUrl: "https://key-a.acme.example/v1" } });
check("a baseUrl is refused when the dashboard allowed no hosts", noHosts.status === 400 && /hasn't allowed it any hosts/.test(noHosts.text), `${noHosts.status} ${noHosts.text.slice(0, 120)}`);
const hostsMgmt = await makeKey("e2e hosts", { providerKeys: { enabled: true, baseUrlHosts: ["*.acme.example"] } });
const hostsMe = await call("GET", "/api/management/v1/me", { token: hostsMgmt });
check("GET /me shows the allowed hosts", JSON.stringify(hostsMe.json?.managementKey?.scopes?.providerKeys?.baseUrlHosts) === '["*.acme.example"]');
const httpUrl = await call("POST", "/api/management/v1/provider-keys", { token: hostsMgmt, data: { provider: "openai", apiKey: fakeUpstream, baseUrl: "http://key-a.acme.example/v1" } });
check("a http baseUrl is refused", httpUrl.status === 400 && /must use https/.test(httpUrl.text), String(httpUrl.status));
const notCustom = await call("POST", "/api/management/v1/provider-keys", { token: hostsMgmt, data: { provider: "openai", apiKey: fakeUpstream, baseUrl: "https://key-a.acme.example/v1" } });
check("a baseUrl is refused for a provider with no per-key URL", notCustom.status === 400 && /custom OpenAI- or Anthropic-compatible/.test(notCustom.text), String(notCustom.status));
const badPattern = await context.request.post("/api/management-keys", { data: { name: "e2e bad hosts", scopes: { providerKeys: { enabled: true, baseUrlHosts: ["*"] } } } });
check("the dashboard refuses a bare * host pattern", badPattern.status() === 400, String(badPattern.status()));
const noClient = await call("GET", "/api/management/v1/client-keys", { token: providerMgmt });
check("a provider-keys-only key can't list client keys", noClient.status === 403, String(noClient.status));

check("no response carried the upstream key", bodies.every((b) => !b.text.includes(fakeUpstream)));
check("no response carried a management secret", bodies.every((b) => !b.text.includes(clientMgmt) && !b.text.includes(providerMgmt)));

const del = await call("DELETE", `/api/management/v1/client-keys/${created.json?.clientKey?.id}`, { token: clientMgmt });
check("delete its own client key", del.status === 200, String(del.status));

// A remote caller: custom-server.js treats forwarding headers as a proxied, non-local request.
const REMOTE = { "X-Forwarded-For": "203.0.113.7" };
const remoteMe = await call("GET", "/api/management/v1/me", { token: clientMgmt, headers: REMOTE });
check("remote: the management API works with the key", remoteMe.status === 200, String(remoteMe.status));
const remoteNoKey = await call("GET", "/v1/models", { headers: REMOTE });
check("remote: /v1 without a key is refused", remoteNoKey.status === 401, String(remoteNoKey.status));
const remoteCodex = await call("POST", "/backend-api/codex/responses", { headers: REMOTE, data: { model: "x", input: "hi" } });
check("remote: /backend-api/codex without a key is refused by the guard", remoteCodex.status === 401 && /API key required for remote API access/.test(remoteCodex.text), `${remoteCodex.status} ${remoteCodex.text.slice(0, 120)}`);
const remoteMgmtV1 = await call("GET", "/v1/models", { token: clientMgmt, headers: REMOTE });
check("remote: management key refused on /v1", remoteMgmtV1.status === 401 && /management key can't be used for inference/.test(remoteMgmtV1.text), String(remoteMgmtV1.status));
const codexMgmt = await call("POST", "/backend-api/codex/responses", { token: clientMgmt, data: { model: "x", input: "hi" } });
check("management key refused on /backend-api/codex from loopback", codexMgmt.status === 401 && /management key can't be used for inference/.test(codexMgmt.text), String(codexMgmt.status));
const padded = await call("GET", "/v1/models", { headers: { Authorization: `Bearer  ${clientMgmt}` } });
check("a padded management key is refused on /v1", padded.status === 401, String(padded.status));

// Expiry and revocation, through the dashboard.
const expiring = await makeKey("e2e expiring", { providerKeys: { enabled: true } });
check("a fresh key works", (await call("GET", "/api/management/v1/me", { token: expiring })).status === 200);
const all = await (await context.request.get("/api/management-keys")).json();
const expId = all.managementKeys.find((k) => k.name === "e2e expiring").id;
await context.request.patch(`/api/management-keys/${expId}`, { data: { expiresAt: new Date(Date.now() - 1000).toISOString() } });
check("an expired key is refused", (await call("GET", "/api/management/v1/me", { token: expiring })).status === 401);
await context.request.patch(`/api/management-keys/${expId}`, { data: { expiresAt: null } });
check("clearing the expiry brings it back", (await call("GET", "/api/management/v1/me", { token: expiring })).status === 200);
const revoked = await context.request.delete(`/api/management-keys/${expId}`);
check("dashboard revokes the key", revoked.ok(), String(revoked.status()));
check("a revoked key is refused", (await call("GET", "/api/management/v1/me", { token: expiring })).status === 401);

// Dashboard section.
const page = await context.newPage();
page.on("console", (m) => { if (m.type() === "error") console.log(`[browser] ${m.text()}`); });
await page.goto("/dashboard/endpoint", { waitUntil: "domcontentloaded" });
const card = page.locator("#management-keys");
await card.getByText("e2e client keys", { exact: true }).first().waitFor({ state: "visible", timeout: 60000 });
await page.waitForLoadState("networkidle").catch(() => {});
check("card lists the keys", await card.getByText("e2e provider keys", { exact: true }).first().isVisible());
check("card shows recent activity", await card.getByText("Recent activity").first().isVisible());
check("card shows a refusal", (await card.innerText()).includes("was refused"));
await card.scrollIntoViewIfNeeded();
await card.screenshot({ path: `${outDir}/management-keys-card.png` });

await card.getByRole("button", { name: "Create Key" }).click();
await page.getByPlaceholder("e.g. Key rotation script").fill("e2e from the UI");
await page.getByRole("switch", { name: "Provider keys" }).click();
await page.waitForTimeout(500); // the toggle's transition
const hostBox = page.getByLabel("Add an allowed host");
await hostBox.fill("*");
await hostBox.locator("xpath=following-sibling::button").click();
check("the dialog refuses a bare * host", await page.getByText("a bare * would allow any host").first().isVisible());
await hostBox.fill("*.acme.example");
await hostBox.locator("xpath=following-sibling::button").click();
check("the dialog lists the added host", await page.getByRole("button", { name: "Remove *.acme.example" }).isVisible());
await page.screenshot({ path: `${outDir}/create-modal.png`, fullPage: false });
await page.getByRole("button", { name: "Create", exact: true }).click();
const secretBox = page.locator("input[readonly]");
await page.getByText("Management key created").first().waitFor({ state: "visible", timeout: 30000 });
// The title can paint a frame before the input holds the value; wait for the value itself.
await page.waitForFunction(() => [...document.querySelectorAll("input[readonly]")].some((e) => e.value.startsWith("10r-mgmt-")), null, { timeout: 30000 }).catch(() => {});
const shown = await secretBox.evaluateAll((els) => els.map((e) => e.value).find((v) => v.startsWith("10r-mgmt-")) || "");
check("secret shown once after create", shown.startsWith("10r-mgmt-"));
await page.waitForTimeout(500); // the modal's fade-in
// The secret is a throwaway from this run's database; masked all the same.
await page.screenshot({ path: `${outDir}/secret-modal.png`, fullPage: false, mask: [secretBox] });
await page.getByRole("button", { name: "Done" }).click();
await card.getByText("e2e from the UI", { exact: true }).first().waitFor({ state: "visible", timeout: 30000 });
check("new key is listed", true);
check("the list never shows the secret", !(await card.innerText()).includes(shown));
const viaUi = await call("GET", "/api/management/v1/me", { token: shown });
check("the UI-created key works", viaUi.status === 200 && viaUi.json?.managementKey?.scopes?.providerKeys?.enabled === true, String(viaUi.status));
check("the UI-created key has the host it was given", JSON.stringify(viaUi.json?.managementKey?.scopes?.providerKeys?.baseUrlHosts) === '["*.acme.example"]');
check("the card shows the hosts in the scope summary", (await card.innerText()).includes("own URLs on *.acme.example"));
await page.screenshot({ path: `${outDir}/endpoint-page.png`, fullPage: true, mask: [page.locator("code")] });

await browser.close();
await anon.dispose();
if (failed) {
  console.log(`${failed} check(s) failed`);
  process.exit(1);
}
console.log("all checks passed");
