import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const suites = {
  live: { RUN_REAL: "1", RUN_MIMO_FREE_LIVE_TESTS: "1" },
  e2e: { RUN_E2E: "1" },
};
const [suite, ...args] = process.argv.slice(2);
if (!Object.hasOwn(suites, suite)) {
  console.error("Expected suite: live or e2e");
  process.exit(2);
}

const vitest = fileURLToPath(new URL("./vitest.mjs", import.meta.resolve("vitest/package.json")));
const result = spawnSync(process.execPath, [
  vitest, "run", "--config", `./vitest.${suite}.config.js`, "--reporter=verbose", ...args,
], {
  cwd: fileURLToPath(new URL("..", import.meta.url)),
  env: { ...process.env, ...suites[suite] },
  stdio: "inherit",
});
if (result.error) console.error(result.error.message);
process.exit(result.status ?? 1);
