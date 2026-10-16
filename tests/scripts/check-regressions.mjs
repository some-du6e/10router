import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const testsRoot = fileURLToPath(new URL("..", import.meta.url));
const vitest = fileURLToPath(new URL("./vitest.mjs", import.meta.resolve("vitest/package.json")));
const temporary = mkdtempSync(join(tmpdir(), "10router-regressions-"));
const report = join(temporary, "results.json");
let exitCode = 1;
try {
  const run = spawnSync(process.execPath, [vitest, "run", "--config", "./vitest.config.js",
    "--reporter=default", "--reporter=json", `--outputFile.json=${report}`],
  { cwd: testsRoot, stdio: "inherit" });
  if (run.error || run.signal) throw run.error || new Error(`Vitest terminated by ${run.signal}`);
  const gate = spawnSync(process.execPath,
    [fileURLToPath(new URL("../__baseline__/verify-no-regression.mjs", import.meta.url)), report],
    { cwd: testsRoot, stdio: "inherit" });
  exitCode = gate.status === 0 && run.status === 0 ? 0 : 1;
} catch (error) {
  console.error(error.message);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
process.exit(exitCode);
