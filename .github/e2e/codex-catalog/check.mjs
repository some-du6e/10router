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
const configText = (side) => readFileSync(join(workDir, side, "home", ".codex", "config.toml"), "utf8");
// `withCatalogUrl` adds the line by hand, to see what this Codex does with it
// when the dashboard (rightly) didn't write it.
async function freshHome(side, { withCatalogUrl = false } = {}) {
  const home = mkdtempSync(join(tmpdir(), "codex-home-"));
  if (side) {
    copyFileSync(join(workDir, side, "home", ".codex", "config.toml"), join(home, "config.toml"));
    if (withCatalogUrl && !configText(side).includes("model_catalog_url")) {
      const text = configText(side).replace(/^(base_url = "([^"]+)")$/m, `$1\nmodel_catalog_url = "$2/models"`);
      writeFileSync(join(home, "config.toml"), text);
    }
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

// 2. Over HTTP, with the dashboard's config and an API-key login.
//
// The dashboard writes model_catalog_url only for Codex 0.166 or newer
// (src/shared/utils/codexCatalog.js). Below that:
// - 0.156 to 0.159 merge the URL's list with their own and refuse a body over
//   1 MiB (MAX_MODEL_CATALOG_BYTES), keeping their own list;
// - 0.160 to 0.165 switch to explicit catalog mode (with_provider_catalog):
//   their own list is dropped, and a failed fetch, an over-1 MiB body among
//   them, leaves no models at all;
// - before 0.156 there is no such setting.
// The over-cap error isn't printed by `codex debug models`, so it's seen here
// by its effect.
const expectUrl = !before("0.166.0");
const headHasUrl = configText("head").includes("model_catalog_url");
if (headHasUrl === expectUrl) pass(`dashboard config ${expectUrl ? "has" : "leaves out"} model_catalog_url for ${version}`);
else fail(`dashboard config ${headHasUrl ? "has" : "lacks"} model_catalog_url for ${version}`);

let servedFile = catalogFile("head");
const requests = [];
const server = createServer((req, res) => {
  requests.push(req.url);
  if (!req.url.startsWith("/backend-api/codex/models")) { res.writeHead(404).end(); return; }
  res.writeHead(200, { "content-type": "application/json" }).end(readFileSync(servedFile));
});
await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
const fetchWith = async (file, configSide, options) => {
  servedFile = file;
  const home = await freshHome(configSide, options);
  requests.length = 0;
  const run = await codex(home, [...discoveryFlag, "debug", "models"]);
  return { run, asked: requests.filter((u) => u.startsWith("/backend-api/codex/models")) };
};
const describeRun = ({ run, asked }) => {
  const shown = run.models || [];
  const routedShown = shown.filter((m) => routed.some((r) => r.slug === m.slug)).length;
  return { shown, routedShown, text: `asked ${asked.length} times, lists ${shown.length} models (${routedShown} routed)` };
};

if (sides.includes("base")) {
  console.log(`base config + base catalog: Codex ${describeRun(await fetchWith(catalogFile("base"), "base")).text}`);
}

const headBytes = readFileSync(catalogFile("head")).length;
const after = await fetchWith(catalogFile("head"), "head");
if (expectUrl) {
  if (after.asked.length === 0) fail("model_catalog_url: Codex never asked for the catalog");
  else pass(`model_catalog_url: Codex asked ${after.asked[0]}`);
  checkDecoded("model_catalog_url", after.run.models);
} else {
  // Without the line Codex keeps its own models, as with master's config.
  const d = describeRun(after);
  if (d.shown.length === 0 || d.routedShown > 0) fail(`dashboard config: Codex ${d.text}; expected its own list`);
  else pass(`dashboard config: Codex keeps its own ${d.shown.length} models (${d.text})`);

  if (supportsCatalogUrl) {
    // What the line would do here, to pin why it's left out.
    const forced = describeRun(await fetchWith(catalogFile("head"), "head", { withCatalogUrl: true }));
    console.log(`with model_catalog_url added by hand, a ${headBytes}-byte catalog: Codex ${forced.text}`);
    if (before("0.160.0")) {
      if (forced.shown.length === 0 || forced.routedShown > 0) fail(`model_catalog_url over 1 MiB: expected Codex's own list, got: ${forced.text}`);
      else pass("model_catalog_url over 1 MiB: Codex refuses the body and keeps its own list");
    } else {
      pass(`model_catalog_url over 1 MiB: explicit catalog mode leaves Codex with ${forced.shown.length} models`);
    }

    // A catalog under the cap, with the entries that matter, decodes over HTTP.
    const keep = new Set([generic.slug, chatgptBacked?.slug, "gpt-5.5", "codex-auto-review", ...Object.keys(legacy.servedBefore)]);
    const small = head.filter((m) => keep.has(m.slug));
    const smallFile = join(mkdtempSync(join(tmpdir(), "codex-small-")), "catalog.json");
    writeFileSync(smallFile, JSON.stringify({ models: small }));
    const smallRun = await fetchWith(smallFile, "head", { withCatalogUrl: true });
    console.log(`model_catalog_url added by hand, a ${readFileSync(smallFile).length}-byte catalog of ${small.length} entries:`);
    checkDecoded("model_catalog_url (under 1 MiB)", smallRun.run.models, small);
  }
}
server.close();

process.exit(failed ? 1 : 0);
