// Gate: so kết quả test hiện tại với baseline known-fails.
// PASS nếu KHÔNG có test nào pass(baseline) → fail(now). Test mới được phép.
// Usage: node tests/__baseline__/verify-no-regression.mjs <current-results.json>
import { readFileSync } from "fs";
import { fileURLToPath } from "node:url";
import { dirname, relative, sep } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const testsRoot = dirname(here);

// Vitest records absolute paths, so a raw name embeds whoever ran the suite —
// the committed baseline was snapshotted under /Users/Working/router4/app.
// Key on the path relative to tests/ instead, which is the same everywhere.
function testKey(absPath) {
  const rel = relative(testsRoot, absPath);
  const normalized = (rel.startsWith("..") ? absPath : `tests/${rel}`)
    .split(sep)
    .join("/");
  // Fall back to the historical /app/ split for a path outside this checkout
  // (e.g. re-verifying someone else's results.json).
  return normalized.startsWith("tests/")
    ? normalized
    : (absPath.split("/app/")[1] ?? normalized);
}

const knownFails = new Set(
  readFileSync(new URL("./known-fails.txt", import.meta.url), "utf8")
    .split("\n").map(s => s.trim()).filter(Boolean)
);

const resultsPath = process.argv[2];
if (!resultsPath) { console.error("Missing results.json path"); process.exit(2); }

const r = JSON.parse(readFileSync(resultsPath, "utf8"));
if (!Array.isArray(r.testResults) || !Number.isInteger(r.numTotalTests) || r.numTotalTests < 1) {
  console.error("Invalid or empty Vitest report. Run the deterministic suite before checking regressions.");
  process.exit(2);
}
const collectionFailures = r.testResults.filter(f =>
  f.status === "failed" && !f.assertionResults.some(a => a.status === "failed")
);
if (collectionFailures.length) {
  console.error("Test suites failed before producing failed assertions:");
  collectionFailures.forEach(f => console.error(`  ${testKey(f.name)}: ${f.message || "suite setup/collection failed"}`));
  process.exit(1);
}
const nowFails = r.testResults.flatMap(f =>
  f.assertionResults.filter(a => a.status === "failed")
    .map(a => testKey(f.name) + " :: " + a.fullName)
);

// A results.json whose paths don't resolve is worse than useless — every known
// fail reads as a regression. Say so instead of printing a wall of false ones.
if (nowFails.length && !nowFails.some(f => f.startsWith("tests/"))) {
  console.error(
    `\n❌ Could not map test paths in ${resultsPath}.\n` +
    `   No name resolved under tests/ — results from a different checkout,\n` +
    `   or not a vitest --reporter=json file. Refusing to guess at regressions.\n\n` +
    `   e.g. ${nowFails[0]}\n`
  );
  process.exit(2);
}

// Regression = fail bây giờ NHƯNG không có trong baseline known-fails
const regressions = nowFails.filter(f => !knownFails.has(f));

if (regressions.length) {
  console.error(`\n❌ REGRESSION: ${regressions.length} test pass→fail:\n`);
  regressions.forEach(f => console.error("  - " + f));
  process.exit(1);
}
if (r.success !== true && nowFails.length === 0) {
  console.error("Vitest reported runner errors despite passing assertions. Inspect the test runner output.");
  process.exit(1);
}
console.log(`✅ No regression. (now fails=${nowFails.length}, baseline known=${knownFails.size}, all known)`);
