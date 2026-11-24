// Drift check for the Go gateway's ports (docs/GO_GATEWAY.md, "Drift").
// Reads changed paths (one per line) on stdin and fails when one is a Node
// file gateway/node-map.json maps to a Go package but nothing under gateway/
// changed with it: the PR must update the port, or list the package in
// gateway/GATEWAY_PROXY_ONLY (which is under gateway/ too).
//
//   git diff --name-only origin/master...HEAD | node scripts/gateway-drift-check.mjs
import { existsSync, readFileSync } from "node:fs";

const map = JSON.parse(readFileSync(new URL("../gateway/node-map.json", import.meta.url), "utf8"));
const changed = readFileSync(0, "utf8").split("\n").map((l) => l.trim()).filter(Boolean);

const missing = [];
const touched = [];
for (const [pkg, files] of Object.entries(map)) {
  if (pkg.startsWith("_")) continue;
  for (const file of files) {
    // A renamed or deleted file must leave the map too.
    if (!existsSync(new URL(`../${file}`, import.meta.url))) missing.push(`${pkg}: ${file}`);
    if (changed.includes(file)) touched.push(`${file} (gateway/internal/${pkg})`);
  }
}

let failed = false;
if (missing.length) {
  console.log(`gateway/node-map.json names files that don't exist:\n  ${missing.join("\n  ")}`);
  failed = true;
}
if (touched.length && !changed.some((f) => f.startsWith("gateway/"))) {
  console.log(
    `This PR changes Node files the Go gateway ports:\n  ${touched.join("\n  ")}\n` +
    "Update the Go port (and its parity fixtures: CLAUDEPREP_RECORD=1 on tests/unit/gateway-claudeprep-parity.test.js), " +
    "or add the package to gateway/GATEWAY_PROXY_ONLY so the gateway keeps proxying that route.",
  );
  failed = true;
}
if (!failed) console.log(touched.length ? `Mapped Node files changed with gateway/: ${touched.length}` : "No mapped Node files changed.");
process.exit(failed ? 1 : 0);
