// Asserts on the lifespan API bodies captured by curl.
// Usage: node check-api.mjs <alpha.json> <beta.json> <unauth-status>
import { readFileSync } from "node:fs";

const [alphaFile, betaFile, unauthStatus] = process.argv.slice(2);
const alphaRaw = readFileSync(alphaFile, "utf8");
const betaRaw = readFileSync(betaFile, "utf8");
const alpha = JSON.parse(alphaRaw);
const beta = JSON.parse(betaRaw);

let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) failed++;
};
const near = (a, b, eps) => typeof a === "number" && Math.abs(a - b) <= eps;

const CREDENTIAL_KEYS = new Set([
  "apiKey", "accessToken", "refreshToken", "idToken", "token", "password", "secret",
  "name", "email", "providerSpecificData", "baseUrl", "authType",
]);
function credentialHits(value, path = "$", hits = []) {
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (CREDENTIAL_KEYS.has(k)) hits.push(`${path}.${k}`);
      credentialHits(v, `${path}.${k}`, hits);
    }
  }
  return hits;
}

const est = alpha.estimate;
check("alpha: estimate present", !!est);
check("alpha: metric is cost", est?.metric === "cost", est?.metric);
check("alpha: typical budget ~$552", near(est?.median, 552, 0.5), est?.median);
check("alpha: p25 ~$454, p75 ~$646", near(est?.low, 454, 0.5) && near(est?.high, 646, 0.5), `${est?.low}-${est?.high}`);
check("alpha: 9 dead keys used, 1 early death excluded", est?.sampleSize === 9 && est?.excluded === 1, `${est?.sampleSize}/${est?.excluded}`);
check("alpha: only the active key has an entry", JSON.stringify(Object.keys(alpha.keys || {})) === '["alpha-active"]', Object.keys(alpha.keys || {}).join(","));
const k = alpha.keys?.["alpha-active"];
check("alpha: active key used $230 (failed request ignored)", near(k?.used, 230, 0.01), k?.used);
check("alpha: active key ~58% left", near(k?.percentLeft, 58.33, 0.1) && Math.round(k?.percentLeft) === 58, k?.percentLeft);
check("alpha: burn rate ~$5/h from last 6h", near(k?.ratePerHour, 5, 0.05), k?.ratePerHour);
check("alpha: eta ~64h", near(k?.etaHours, 64.4, 0.5), k?.etaHours);

const forbidden = /sk-e2e-fake|e2e\.invalid/;
check("alpha: no credential fields in body", credentialHits(alpha).length === 0 && !forbidden.test(alphaRaw), credentialHits(alpha).join(","));
check("beta: no credential fields in body", credentialHits(beta).length === 0 && !forbidden.test(betaRaw), credentialHits(beta).join(","));
check("beta: no estimate with only 2 dead keys", beta.estimate === null && Object.keys(beta.keys || {}).length === 0, betaRaw);
check("unauthenticated request rejected", unauthStatus === "401", unauthStatus);

if (failed) {
  console.log(`${failed} assertion(s) failed`);
  process.exit(1);
}
console.log("all API assertions passed");
