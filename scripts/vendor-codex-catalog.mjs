#!/usr/bin/env node
// Refresh the Codex metadata the router serves at /backend-api/codex/models
// from a Codex release tag:
//
//   node scripts/vendor-codex-catalog.mjs rust-v0.167.2
//
// open-sse/config/codex/models.json is Codex's bundled catalog
// (codex-rs/models-manager/models.json), byte for byte. prompt.json wraps
// Codex's generic prompt (codex-rs/models-manager/prompt.md), text unchanged.
// Both are Apache-2.0. The tag also goes into CODEX_CATALOG_VERSION
// (src/lib/codex/modelCatalog.js) and THIRD_PARTY_NOTICES.md;
// tests/unit/codex-model-catalog.test.js checks they agree. Then run that test
// and the Codex model catalog workflow.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const tag = process.argv[2];
const version = /^rust-v(\d+\.\d+\.\d+)$/.exec(tag || "")?.[1];
if (!version) {
  console.error("usage: node scripts/vendor-codex-catalog.mjs rust-vX.Y.Z");
  process.exit(1);
}

const root = (path) => fileURLToPath(new URL(`../${path}`, import.meta.url));
const raw = (path) => `https://raw.githubusercontent.com/openai/codex/${tag}/${path}`;

async function get(path) {
  const response = await fetch(raw(path));
  if (!response.ok) throw new Error(`${path} at ${tag}: HTTP ${response.status}`);
  return response.text();
}

// Fetch everything before writing anything, so a failed download leaves the
// vendored files as they were.
const [models, instructions] = await Promise.all([
  get("codex-rs/models-manager/models.json"),
  get("codex-rs/models-manager/prompt.md"),
]);
const count = JSON.parse(models).models.length;
const prompt = JSON.stringify({
  source: `https://github.com/openai/codex/blob/${tag}/codex-rs/models-manager/prompt.md`,
  license: "Apache-2.0, Copyright 2025 OpenAI",
  instructions,
}, null, 2) + "\n";
const replaceIn = (path, pattern, replacement) => {
  const text = readFileSync(root(path), "utf8");
  if (!pattern.test(text)) throw new Error(`${path}: nothing matches ${pattern}`);
  return [path, text.replace(pattern, replacement)];
};
const edits = [
  replaceIn("src/lib/codex/modelCatalog.js", /CODEX_CATALOG_VERSION = "[^"]+"/, `CODEX_CATALOG_VERSION = "${version}"`),
  replaceIn("THIRD_PARTY_NOTICES.md", /rust-v\d+\.\d+\.\d+/g, tag),
];

writeFileSync(root("open-sse/config/codex/models.json"), models);
writeFileSync(root("open-sse/config/codex/prompt.json"), prompt);
for (const [path, text] of edits) writeFileSync(root(path), text);

console.log(`${tag}: ${count} models, ${instructions.length}-char prompt`);
