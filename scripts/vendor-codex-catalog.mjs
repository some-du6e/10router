#!/usr/bin/env node
// Refresh the Codex metadata the router serves at /backend-api/codex/models
// from a Codex release tag:
//
//   node scripts/vendor-codex-catalog.mjs rust-v0.167.2
//
// Writes, in open-sse/config/codex/:
// - models.json: Codex's bundled catalog (codex-rs/models-manager/models.json)
//   at that tag, byte for byte.
// - prompt.json: Codex's generic prompt (codex-rs/models-manager/prompt.md),
//   text unchanged, wrapped in JSON.
// - legacy-models.json: the entries of models older Codex versions bundle and
//   the tag above no longer does, each taken unchanged from the newest tag that
//   still bundles it (LEGACY below). Once the router's catalog decodes, Codex
//   drops its own, so an older client would lose these otherwise.
// All Apache-2.0. The tags also go into CODEX_CATALOG_VERSION
// (src/lib/codex/modelCatalog.js) and the generated block in
// THIRD_PARTY_NOTICES.md; tests/unit/codex-model-catalog.test.js checks they
// agree. Then run that test and the Codex model catalog workflow.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// slug -> newest Codex release tag whose bundled catalog still has it.
const LEGACY = {
  "gpt-5.4": "rust-v0.157.1",
  "gpt-5.4-mini": "rust-v0.154.0",
  "gpt-5.2": "rust-v0.154.0",
  "gpt-5.3-codex": "rust-v0.143.0",
};
// slug -> first client_version it isn't served to. Alphas report their
// release's version, so a cut-off has to cover an alpha that still bundles it,
// at the cost of the stable release with the same version:
// rust-v0.158.0-alpha.1 bundles gpt-5.4 (so all of 0.158.0 gets it, stable
// and later alphas too), rust-v0.144.0-alpha.1 bundles gpt-5.3-codex (so
// 0.144.0 gets it, not 0.144.1 to 0.144.6), and no 0.155.0 alpha has
// gpt-5.4-mini or gpt-5.2.
const SERVED_BEFORE = {
  "gpt-5.4": "0.159.0",
  "gpt-5.4-mini": "0.155.0",
  "gpt-5.2": "0.155.0",
  "gpt-5.3-codex": "0.144.1",
};

const legacySlugs = Object.keys(LEGACY).sort().join(", ");
const servedSlugs = Object.keys(SERVED_BEFORE).sort().join(", ");
if (legacySlugs !== servedSlugs) {
  console.error(`LEGACY (${legacySlugs}) and SERVED_BEFORE (${servedSlugs}) must name the same models.`);
  process.exit(1);
}

const tag = process.argv[2];
const version = /^rust-v(\d+\.\d+\.\d+)$/.exec(tag || "")?.[1];
if (!version) {
  console.error("usage: node scripts/vendor-codex-catalog.mjs rust-vX.Y.Z");
  process.exit(1);
}

const root = (path) => fileURLToPath(new URL(`../${path}`, import.meta.url));
const raw = (ref, path) => `https://raw.githubusercontent.com/openai/codex/${ref}/${path}`;
const MODELS = "codex-rs/models-manager/models.json";
const PROMPT = "codex-rs/models-manager/prompt.md";

async function get(ref, path) {
  const response = await fetch(raw(ref, path));
  if (!response.ok) throw new Error(`${path} at ${ref}: HTTP ${response.status}`);
  return response.text();
}

// Fetch everything before writing anything, so a failed download leaves the
// vendored files as they were.
const legacyTags = [...new Set(Object.values(LEGACY))];
const [models, instructions, ...legacyCatalogs] = await Promise.all([
  get(tag, MODELS),
  get(tag, PROMPT),
  ...legacyTags.map((ref) => get(ref, MODELS)),
]);
const current = new Set(JSON.parse(models).models.map((m) => m.slug));
const legacyBySlug = new Map();
legacyTags.forEach((ref, i) => {
  for (const entry of JSON.parse(legacyCatalogs[i]).models) {
    if (LEGACY[entry.slug] === ref) legacyBySlug.set(entry.slug, entry);
  }
});
for (const [slug, ref] of Object.entries(LEGACY)) {
  if (!legacyBySlug.has(slug)) throw new Error(`${slug} is not in ${ref}'s bundled catalog`);
  if (current.has(slug)) throw new Error(`${slug} is bundled again at ${tag}; drop it from LEGACY`);
}
const legacy = JSON.stringify({
  sources: LEGACY,
  servedBefore: SERVED_BEFORE,
  models: Object.keys(LEGACY).map((slug) => legacyBySlug.get(slug)),
}, null, 2) + "\n";

const prompt = JSON.stringify({
  source: `https://github.com/openai/codex/blob/${tag}/${PROMPT}`,
  license: "Apache-2.0, Copyright 2025 OpenAI",
  instructions,
}, null, 2) + "\n";

const notice = [
  "<!-- vendored-codex:start (written by scripts/vendor-codex-catalog.mjs) -->",
  "- `open-sse/config/codex/models.json`: Codex's bundled model catalog,",
  "  `codex-rs/models-manager/models.json` from https://github.com/openai/codex at",
  `  tag \`${tag}\`. Unmodified.`,
  "- `open-sse/config/codex/prompt.json`: Codex's generic prompt,",
  "  `codex-rs/models-manager/prompt.md` at the same tag. Modified: converted to",
  "  JSON (the `instructions` string), text unchanged.",
  "- `open-sse/config/codex/legacy-models.json`: entries of",
  "  `codex-rs/models-manager/models.json` that older Codex releases bundle,",
  "  each from the newest tag that still has it. Modified: collected into one",
  "  file, entries unchanged.",
  ...Object.entries(LEGACY).map(([slug, ref]) => `  - \`${slug}\`: tag \`${ref}\``),
  "<!-- vendored-codex:end -->",
].join("\n");

const replaceIn = (path, pattern, replacement) => {
  const text = readFileSync(root(path), "utf8");
  if (!pattern.test(text)) throw new Error(`${path}: nothing matches ${pattern}`);
  return [path, text.replace(pattern, replacement)];
};
const edits = [
  replaceIn("src/lib/codex/modelCatalog.js", /CODEX_CATALOG_VERSION = "[^"]+"/, `CODEX_CATALOG_VERSION = "${version}"`),
  replaceIn("THIRD_PARTY_NOTICES.md", /<!-- vendored-codex:start[\s\S]*?<!-- vendored-codex:end -->/, notice),
];

writeFileSync(root("open-sse/config/codex/models.json"), models);
writeFileSync(root("open-sse/config/codex/prompt.json"), prompt);
writeFileSync(root("open-sse/config/codex/legacy-models.json"), legacy);
for (const [path, text] of edits) writeFileSync(root(path), text);

console.log(`${tag}: ${current.size} models, ${instructions.length}-char prompt, ${legacyBySlug.size} legacy models`);
