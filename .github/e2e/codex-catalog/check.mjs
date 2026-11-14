// Has a real Codex binary read the catalog the router serves, the way users
// get it: from a file (model_catalog_json), and over HTTP with the config the
// dashboard writes and an API-key login. The server here only serves that
// catalog; no model is called.
//
//   node check.mjs <codex-bin> <work-dir> <port>
//
// <work-dir>/{head,base}/catalog.json and <work-dir>/{head,base}/home/.codex/config.toml
// come from dump-catalog.test.js, with CODEX_ROUTER_URL=http://127.0.0.1:<port>.
// "base" is the branch the PR targets, kept to show what Codex did before.
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [codexBin, workDir, portArg] = process.argv.slice(2);
const port = Number(portArg);
let failed = false;
const fail = (message) => { failed = true; console.log(`FAIL ${message}`); };
const pass = (message) => console.log(`ok   ${message}`);

// Async on purpose: the catalog server below runs in this process.
function codex(home, args, input) {
  return new Promise((resolve) => {
    const child = spawn(codexBin, args, { env: { ...process.env, CODEX_HOME: home } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
    child.on("close", (status) => {
      clearTimeout(timer);
      let models = null;
      try { models = JSON.parse(stdout).models; } catch { /* not a catalog */ }
      const errorLine = stderr.split("\n").find((l) => /failed|error/i.test(l)) || "";
      resolve({ status, stdout, stderr, models, errorLine: errorLine.trim() });
    });
    child.stdin.end(input ?? "");
  });
}

const version = (await codex(tmpdir(), ["--version"])).stdout.trim();
const parse = (v) => (/(\d+)\.(\d+)\.(\d+)/.exec(v) || []).slice(1).map(Number);
const client = parse(version);
const before = (v) => {
  const other = parse(v);
  for (let i = 0; i < 3; i++) if (client[i] !== other[i]) return client[i] < other[i];
  return false;
};
// model_catalog_url arrived in 0.156.0. Reading it with an API key is the
// api_key_model_discovery feature, off by default until 0.161.0.
const supportsCatalogUrl = !before("0.156.0");
const discoveryFlag = before("0.161.0") ? ["-c", "features.api_key_model_discovery=true"] : [];
const legacy = JSON.parse(readFileSync(new URL("../../../open-sse/config/codex/legacy-models.json", import.meta.url), "utf8"));
const catalogFile = (side) => join(workDir, side, "catalog.json");
const catalog = (side) => JSON.parse(readFileSync(catalogFile(side), "utf8")).models;
const sides = existsSync(catalogFile("base")) ? ["base", "head"] : ["head"];

// A Codex home with a side's dashboard config, signed in the way the docs say:
// `codex login --with-api-key`. The key is a stand-in; nothing checks it.
async function freshHome(side) {
  const home = mkdtempSync(join(tmpdir(), "codex-home-"));
  if (side) {
    copyFileSync(join(workDir, side, "home", ".codex", "config.toml"), join(home, "config.toml"));
    const login = await codex(home, ["login", "--with-api-key"], "sk-placeholder");
    if (login.status !== 0) fail(`codex login --with-api-key: exit ${login.status}: ${login.stderr}`);
  }
  return home;
}

const head = catalog("head");
const routed = head.filter((m) => m.visibility === "list");
const generic = routed.find((m) => m.slug.startsWith("cc/claude-"));
const chatgptBacked = routed.find((m) => m.slug === "cx/gpt-5.5");
console.log(`${version}: head catalog has ${head.length} entries (${routed.length} listed), ${readFileSync(catalogFile("head")).length} bytes`);

function checkDecoded(label, models, served = head) {
  if (!models) return fail(`${label}: Codex printed no catalog`);
  const bySlug = new Map(models.map((m) => [m.slug, m]));
  // Every entry served, hidden ones included (Codex's bare and older models).
  const missing = served.filter((m) => !bySlug.has(m.slug));
  if (missing.length) return fail(`${label}: ${missing.length} served models missing, e.g. ${missing[0].slug}`);
  // The models this Codex bundles and 0.167.2 doesn't (legacy-models.json servedBefore).
  const expectedOlder = Object.entries(legacy.servedBefore).filter(([, cutoff]) => before(cutoff)).map(([slug]) => slug);
  const missingOlder = expectedOlder.filter((s) => !bySlug.has(s));
  if (missingOlder.length) fail(`${label}: older Codex models not served: ${missingOlder.join(", ")}`);
  else if (expectedOlder.length) pass(`${label}: older Codex models ${expectedOlder.join(", ")} decoded`);
  const g = bySlug.get(generic.slug);
  const instructions = g.model_messages?.instructions_template ?? g.base_instructions ?? "";
  if (g.apply_patch_tool_type !== "freeform") fail(`${label}: ${g.slug} apply_patch_tool_type = ${g.apply_patch_tool_type}`);
  if (!instructions.startsWith("You are a coding agent")) fail(`${label}: ${g.slug} has no base instructions`);
  pass(`${label}: ${models.length} models decoded; ${g.slug} has apply_patch_tool_type=${g.apply_patch_tool_type}, shell_type=${g.shell_type}, ${instructions.length}-char instructions`);
  if (chatgptBacked) {
    const c = bySlug.get(chatgptBacked.slug);
    const prompt = c.model_messages?.instructions_template ?? c.base_instructions ?? "";
    if (!prompt || prompt.startsWith("You are a coding agent running in the Codex CLI")) fail(`${label}: ${c.slug} lost its own prompt`);
    else pass(`${label}: ${c.slug} keeps Codex's own metadata (${prompt.length}-char prompt, apply_patch_tool_type=${c.apply_patch_tool_type})`);
    // Before 0.148 (0.147.0 alphas report 0.147.0), `[features] personality = false` drops the template and
    // Codex runs on base_instructions alone (with_config_overrides).
    if (before("0.148.0")) {
      const fallback = c.base_instructions ?? "";
      if (fallback !== prompt) fail(`${label}: ${c.slug} base_instructions (${fallback.length} chars) isn't its prompt; personality = false would leave it with ${fallback ? "another" : "no"} system prompt`);
      else pass(`${label}: ${c.slug} with its template cleared still has its ${fallback.length}-char prompt in base_instructions`);
    }
  }
  const bare = ["gpt-5.5", "codex-auto-review"].map((slug) => bySlug.get(slug));
  if (bare.some((m) => m?.visibility !== "hide")) fail(`${label}: Codex's bare models missing or not hidden`);
  else pass(`${label}: bare ${bare.map((m) => m.slug).join(", ")} decoded, hidden`);
}

// 1. From a file.
for (const side of sides) {
  const run = await codex(await freshHome(), ["-c", `model_catalog_json=${JSON.stringify(catalogFile(side))}`, "debug", "models"]);
  if (side === "head") {
    if (run.status !== 0) fail(`model_catalog_json: exit ${run.status}: ${run.errorLine}`);
    else checkDecoded("model_catalog_json", run.models);
  } else {
    console.log(`base catalog via model_catalog_json: exit ${run.status}${run.status ? `: ${run.errorLine}` : ""}`);
  }
}

// 2. Over HTTP, with the dashboard's config, from 0.156.0 (the first with model_catalog_url).
// 0.156 to 0.165 refuse a model_catalog_url body over 1 MiB
// (MAX_MODEL_CATALOG_BYTES in model-provider/src/models_endpoint.rs) and keep
// their own list; 0.166 dropped the limit.
const CATALOG_URL_LIMIT = before("0.166.0") ? 1024 * 1024 : Infinity;
if (supportsCatalogUrl) {
  let servedFile = catalogFile("head");
  const requests = [];
  const server = createServer((req, res) => {
    requests.push(req.url);
    if (!req.url.startsWith("/backend-api/codex/models")) { res.writeHead(404).end(); return; }
    res.writeHead(200, { "content-type": "application/json" }).end(readFileSync(servedFile));
  });
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  const fetchWith = async (file, configSide) => {
    servedFile = file;
    const home = await freshHome(configSide);
    requests.length = 0;
    const run = await codex(home, [...discoveryFlag, "debug", "models"]);
    return { run, asked: requests.filter((u) => u.startsWith("/backend-api/codex/models")) };
  };

  if (sides.includes("base")) {
    const baseRun = await fetchWith(catalogFile("base"), "base");
    const shown = baseRun.run.models || [];
    const listedBefore = shown.filter((m) => routed.some((r) => r.slug === m.slug)).length;
    console.log(`base config + base catalog: Codex asked for the catalog ${baseRun.asked.length} times and lists ${listedBefore} routed models (${shown.length} in all: ${shown.map((m) => m.slug).slice(0, 3).join(", ")}, ...)`);

    const undecodable = await fetchWith(catalogFile("base"), "head");
    console.log(`head config + base catalog: Codex asked ${undecodable.asked.length} times and lists ${(undecodable.run.models || []).length} models`);
  }

  const headBytes = readFileSync(catalogFile("head")).length;
  const after = await fetchWith(catalogFile("head"), "head");
  if (after.asked.length === 0) fail("model_catalog_url: Codex never asked for the catalog");
  else pass(`model_catalog_url: Codex asked ${after.asked[0]}`);

  if (headBytes <= CATALOG_URL_LIMIT) {
    checkDecoded("model_catalog_url", after.run.models);
  } else {
    // Over the cap: Codex must fall back to its own list, not to nothing.
    const shown = after.run.models || [];
    const routedShown = shown.filter((m) => routed.some((r) => r.slug === m.slug)).length;
    if (shown.length === 0 || routedShown > 0) fail(`model_catalog_url: a ${headBytes}-byte catalog should leave Codex on its own list, got ${shown.length} models (${routedShown} routed)`);
    else pass(`model_catalog_url: the ${headBytes}-byte catalog is over this Codex's 1 MiB limit, so it keeps its own ${shown.length} models`);

    // A catalog under the cap, with the entries that matter, decodes over HTTP.
    const keep = new Set([generic.slug, chatgptBacked?.slug, "gpt-5.5", "codex-auto-review", ...Object.keys(legacy.servedBefore)]);
    const small = head.filter((m) => keep.has(m.slug));
    const smallFile = join(mkdtempSync(join(tmpdir(), "codex-small-")), "catalog.json");
    writeFileSync(smallFile, JSON.stringify({ models: small }));
    const smallRun = await fetchWith(smallFile, "head");
    console.log(`model_catalog_url: a ${readFileSync(smallFile).length}-byte catalog of ${small.length} entries:`);
    checkDecoded("model_catalog_url (under 1 MiB)", smallRun.run.models, small);
  }
  server.close();
}

process.exit(failed ? 1 : 0);
