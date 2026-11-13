#!/usr/bin/env node
// Refresh the Codex metadata the router serves at /backend-api/codex/models
// from a Codex release tag:
//
//   node scripts/vendor-codex-catalog.mjs rust-v0.167.2
//
// open-sse/config/codex/models.json is Codex's bundled catalog
// (codex-rs/models-manager/models.json), byte for byte. prompt.json wraps
// Codex's generic prompt (codex-rs/models-manager/prompt.md), text unchanged.
// Both are Apache-2.0; see THIRD_PARTY_NOTICES.md. Afterwards, bump the tag
// there and in CODEX_CATALOG_VERSION (src/lib/codex/modelCatalog.js), then run
// tests/unit/codex-model-catalog.test.js and the Codex model catalog workflow.
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const tag = process.argv[2];
if (!/^rust-v\d+\.\d+\.\d+$/.test(tag || "")) {
  console.error("usage: node scripts/vendor-codex-catalog.mjs rust-vX.Y.Z");
  process.exit(1);
}

const outDir = fileURLToPath(new URL("../open-sse/config/codex/", import.meta.url));
const raw = (path) => `https://raw.githubusercontent.com/openai/codex/${tag}/${path}`;

async function get(path) {
  const response = await fetch(raw(path));
  if (!response.ok) throw new Error(`${path} at ${tag}: HTTP ${response.status}`);
  return response.text();
}

const models = await get("codex-rs/models-manager/models.json");
const count = JSON.parse(models).models.length;
writeFileSync(`${outDir}models.json`, models);

const instructions = await get("codex-rs/models-manager/prompt.md");
writeFileSync(`${outDir}prompt.json`, JSON.stringify({
  source: `https://github.com/openai/codex/blob/${tag}/codex-rs/models-manager/prompt.md`,
  license: "Apache-2.0, Copyright 2025 OpenAI",
  instructions,
}, null, 2) + "\n");

console.log(`${tag}: ${count} models, ${instructions.length}-char prompt`);
