// Golden fixtures for the Go gateway's model catalog reader
// (gateway/internal/claudeprep/catalog.go, docs/GO_GATEWAY.md "Phase 2c").
//
// Node's catalogOverride.js reads DATA_DIR/model-catalog.json, and
// capabilities.js's refine lets it turn vision, pdf and audio input on and
// set maxOutput for models the hand tables don't name. This writes catalog
// files of many shapes, well-formed ones as sync.js writes them and others it
// never writes, and records what Node's lookups and getCapabilitiesForModel
// make of each. The Go test replays every file through FileCatalog and
// NewModels; on a shape sync.js never writes it may decline instead.
//
// Without CATALOG_RECORD this checks that Node still makes the committed
// file. With CATALOG_RECORD=1 it writes it.
import { describe, it, expect, afterAll } from "vitest";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tempDataDir } from "../helpers/nodeDb.js";

const OUT = fileURLToPath(new URL("../../gateway/internal/claudeprep/testdata/catalog.json", import.meta.url));
const RECORD = process.env.CATALOG_RECORD === "1";
const PROVIDER = "openai-compatible-chat-cat";

const dataDir = tempDataDir("catalog-parity-");
process.env.DATA_DIR = dataDir;
const catalog = await import("../../open-sse/providers/catalogOverride.js");
const capabilities = await import("../../open-sse/providers/capabilities.js");
capabilities.setCatalogSource({ getModalities: catalog.getCatalogModalities, getLimits: catalog.getCatalogLimits });
afterAll(() => {
  capabilities.setCatalogSource(null);
  rmSync(dataDir, { recursive: true, force: true });
});

// Models the hand tables don't name, so refine consults the catalog, plus
// ids whose base id is an Object.prototype name or an array index.
const MODELS = [
  "acme/Mystery-1:free",
  "mystery-1",
  "Mystery-1",
  "other/mystery-1",
  "mystery-2",
  "zeta-9",
  "acme/constructor",
  "acme/toString",
  "x/__proto__",
  "0",
  "x/0",
  "length",
  "",
];

const ok = (models, providers) => JSON.stringify({ models, providers });

// [name, file text or null for no file]
const FILES = [
  ["no file", null],
  ["empty object", "{}"],
  ["sync.js shape", ok(
    { "mystery-1": { vision: true, pdf: true }, "zeta-9": { audioInput: true, videoInput: true } },
    { [PROVIDER]: { "acme/Mystery-1:free": { maxOutput: 12345, contextWindow: 99000 }, "mystery-2": { contextWindow: 5000 }, "zeta-9": { maxOutput: 777 } } },
  )],
  ["limits by base id", ok({}, { [PROVIDER]: { "mystery-1": { maxOutput: 4096 } } })],
  ["exact entry shadows the base id", ok({}, { [PROVIDER]: { "acme/Mystery-1:free": { contextWindow: 1 }, "mystery-1": { maxOutput: 4096 } } })],
  ["falsy exact entry falls back to the base id", ok({}, { [PROVIDER]: { "acme/Mystery-1:free": 0, "mystery-1": { maxOutput: 4096 } } })],
  ["null exact entry falls back", ok({}, { [PROVIDER]: { "mystery-1": null, "x/0": null } })],
  ["other provider only", ok({}, { "openai-compatible-chat-else": { "mystery-1": { maxOutput: 4096 } } })],
  ["modality values not exactly true", ok({ "mystery-1": { vision: 1, pdf: "true", audioInput: false } }, {})],
  ["maxOutput zero and negative", ok({}, { [PROVIDER]: { "mystery-1": { maxOutput: 0 }, "zeta-9": { maxOutput: -5 } } })],
  ["fractional maxOutput", ok({}, { [PROVIDER]: { "mystery-1": { maxOutput: 1000.5 } } })],
  ["maxOutput null", ok({}, { [PROVIDER]: { "mystery-1": { maxOutput: null } } })],
  ["prototype-named base ids", ok({ constructor: { vision: true }, tostring: { pdf: true } }, { [PROVIDER]: { tostring: { maxOutput: 3000 }, constructor: { maxOutput: 3001 } } })],
  ["prototype names absent", ok({ "mystery-1": { vision: true } }, { [PROVIDER]: { tostring: { maxOutput: 3000 } } })],
  ["own __proto__ key", "{\"models\":{\"__proto__\":{\"vision\":true}},\"providers\":{}}"],
  ["models falsy", ok(0, { [PROVIDER]: { "mystery-1": { maxOutput: 4096 } } })],
  ["providers null", ok({ "mystery-1": { vision: true } }, null)],
  ["string entries", ok({ "mystery-1": "vision" }, { [PROVIDER]: { "mystery-1": "big", "zeta-9": { maxOutput: 10 } } })],
  ["models a string", ok("vision", {})],
  ["providers a number", ok({}, 5)],
  ["not an object", "[1,2,3]"],
  ["a bare number", "42"],
  ["null document", "null"],
  ["trailing data", "{\"models\":{\"mystery-1\":{\"vision\":true}}} x"],
  ["truncated", "{\"models\":{\"mystery-1\":{\"vision\":true}"],
  ["byte order mark", "﻿" + ok({ "mystery-1": { vision: true } }, {})],
  ["duplicate keys, last wins", "{\"models\":{\"mystery-1\":{\"vision\":true},\"mystery-1\":{\"pdf\":true}},\"providers\":{}}"],
  ["whitespace around", "\n\t " + ok({ "mystery-1": { pdf: true } }, {}) + " \r\n"],
  // Shapes sync.js never writes, where the Go port may decline.
  ["models an array", ok([{ vision: true }], {})],
  ["provider entry an array", ok({}, { [PROVIDER]: [{ maxOutput: 9 }] })],
  ["entry an array", ok({ "mystery-1": [true] }, { [PROVIDER]: { "mystery-1": [1] } })],
  ["maxOutput a string", ok({}, { [PROVIDER]: { "mystery-1": { maxOutput: "5" } } })],
  ["maxOutput true", ok({}, { [PROVIDER]: { "mystery-1": { maxOutput: true } } })],
  ["maxOutput beyond a float64", "{\"models\":{},\"providers\":{\"" + PROVIDER + "\":{\"mystery-1\":{\"maxOutput\":1e400}}}}"],
];

function effectiveModalities(m) {
  if (!m) return null;
  return { vision: m.vision === true, pdf: m.pdf === true, audioInput: m.audioInput === true };
}

// A value Go can't hold as a number (Infinity, a string) is recorded as text.
const asNumberOrText = (v) => (typeof v === "number" && Number.isFinite(v) ? v : String(v));

function effectiveLimits(l) {
  if (!l) return null;
  return { maxOutput: asNumberOrText(l.maxOutput > 0 ? l.maxOutput : 0) };
}

function record() {
  const file = catalog.CATALOG_FILE;
  expect(path.dirname(file)).toBe(dataDir);
  const cases = [];
  for (const [name, text] of FILES) {
    rmSync(file, { force: true });
    if (text !== null) writeFileSync(file, text, "utf8");
    catalog.invalidateCatalog();
    const lookups = MODELS.map((model) => {
      const caps = capabilities.getCapabilitiesForModel(PROVIDER, model);
      return {
        model,
        modalities: effectiveModalities(catalog.getCatalogModalities(model)),
        limits: effectiveLimits(catalog.getCatalogLimits(PROVIDER, model)),
        caps: {
          vision: caps.vision === true,
          pdf: caps.pdf === true,
          audioInput: caps.audioInput === true,
          maxOutput: asNumberOrText(caps.maxOutput),
        },
      };
    });
    cases.push({ name, file: text, provider: PROVIDER, lookups });
  }
  rmSync(file, { force: true });
  return JSON.stringify({ cases }, null, 1) + "\n";
}

describe("model catalog parity fixtures", () => {
  it("Node's catalog reader still makes testdata/catalog.json", () => {
    const text = record();
    if (RECORD) writeFileSync(OUT, text);
    expect(readFileSync(OUT, "utf8"), "Node's catalog reader changed: regenerate with CATALOG_RECORD=1 and update gateway/internal/claudeprep/catalog.go").toBe(text);
  });
});
