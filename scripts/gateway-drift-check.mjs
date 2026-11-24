// Drift check for the Go gateway's ports (docs/GO_GATEWAY.md, Risks, "Drift as Node changes").
// Reads changed paths (one per line) on stdin. For each Go package in
// gateway/node-map.json whose Node files changed, the PR must also change
// that package (gateway/internal/<pkg>/: the port, or its re-recorded
// fixtures) or list the package in gateway/GATEWAY_PROXY_ONLY, so the
// gateway keeps proxying that route. Also fails when a mapped file no longer
// exists, or when the package's parity workflow wouldn't run for it.
//
//   git diff --name-only origin/master...HEAD | node scripts/gateway-drift-check.mjs
import { existsSync, readFileSync } from "node:fs";

const root = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
const map = JSON.parse(read("gateway/node-map.json"));
const proxyOnly = new Set(read("gateway/GATEWAY_PROXY_ONLY").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#")));
const changed = readFileSync(0, "utf8").split("\n").map((l) => l.trim()).filter(Boolean);

// The `paths:` filter of gateway-<pkg>.yml: exact paths and "dir/**" prefixes.
function workflowPaths(pkg) {
  const file = `.github/workflows/gateway-${pkg}.yml`;
  if (!existsSync(new URL(file, root))) return null;
  const block = read(file).split(/\n\s*paths:\s*\n/)[1]?.split(/\n\s*[a-z_]+:/)[0] || "";
  return [...block.matchAll(/^\s*-\s*"([^"]+)"/gm)].map((m) => m[1]);
}
const covered = (file, paths) => paths.some((p) => (p.endsWith("/**") ? file.startsWith(p.slice(0, -2)) : file === p));

const problems = [];
for (const [pkg, files] of Object.entries(map)) {
  if (pkg.startsWith("_")) continue;
  const paths = workflowPaths(pkg);
  if (!paths) problems.push(`.github/workflows/gateway-${pkg}.yml is missing: every mapped package has a parity workflow`);
  for (const file of files) {
    if (!existsSync(new URL(file, root))) problems.push(`gateway/node-map.json: ${file} (${pkg}) doesn't exist; a renamed or deleted file must leave the map`);
    else if (paths && !covered(file, paths)) problems.push(`.github/workflows/gateway-${pkg}.yml: its paths filter misses ${file}, so the parity job wouldn't run when it changes`);
  }
  const touched = files.filter((f) => changed.includes(f));
  if (!touched.length) continue;
  const ported = changed.some((f) => f.startsWith(`gateway/internal/${pkg}/`));
  if (ported || proxyOnly.has(pkg)) {
    console.log(`${pkg}: ${touched.length} mapped Node file(s) changed, ${ported ? "with the port" : "listed in GATEWAY_PROXY_ONLY"}.`);
    continue;
  }
  problems.push(
    `This PR changes Node files gateway/internal/${pkg} ports:\n  ${touched.join("\n  ")}\n` +
    `Update the port (and re-record its fixtures: CLAUDEPREP_RECORD=1 on tests/unit/gateway-${pkg}-parity.test.js), ` +
    `or add "${pkg}" to gateway/GATEWAY_PROXY_ONLY so the gateway keeps proxying that route.`,
  );
}
if (problems.length) {
  console.log(problems.join("\n\n"));
  process.exit(1);
}
console.log("Gateway ports are in step with the Node files they map.");
