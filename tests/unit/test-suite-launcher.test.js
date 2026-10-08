import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let tempDir;
let testsDir;
let launcher;
let invocationDir;
let spawnErrorPreload;
let signalPreload;
const childPrefix = "LAUNCHER_CHILD:";

beforeAll(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "10router-suite-launcher-"));
  testsDir = path.join(tempDir, "tests");
  const scriptsDir = path.join(testsDir, "scripts");
  const vitestDir = path.join(testsDir, "node_modules", "vitest");
  invocationDir = path.join(tempDir, "invoked-from-elsewhere");
  for (const dir of [scriptsDir, vitestDir, invocationDir]) fs.mkdirSync(dir, { recursive: true });

  launcher = path.join(scriptsDir, "run-suite.mjs");
  fs.copyFileSync(fileURLToPath(new URL("../scripts/run-suite.mjs", import.meta.url)), launcher);
  fs.writeFileSync(path.join(vitestDir, "package.json"), JSON.stringify({
    name: "vitest", type: "module", exports: { "./package.json": "./package.json" },
  }));
  // The real launcher resolves and spawns this fixture instead of running any provider tests.
  fs.writeFileSync(path.join(vitestDir, "vitest.mjs"), `
    console.log(${JSON.stringify(childPrefix)} + JSON.stringify({
      args: process.argv.slice(2),
      cwd: process.cwd(),
      env: {
        RUN_REAL: process.env.RUN_REAL,
        RUN_MIMO_FREE_LIVE_TESTS: process.env.RUN_MIMO_FREE_LIVE_TESTS,
        RUN_E2E: process.env.RUN_E2E,
        LAUNCHER_SENTINEL: process.env.LAUNCHER_SENTINEL,
      },
    }));
    process.exit(Number(process.env.LAUNCHER_STUB_EXIT || 0));
  `);

  // Inject failure at the OS spawn boundary while executing the launcher unchanged.
  spawnErrorPreload = path.join(tempDir, "spawn-error.cjs");
  fs.writeFileSync(spawnErrorPreload, `
    require("node:child_process").spawnSync = () => ({
      status: null, error: new Error("fixture spawn failure"),
    });
    require("node:module").syncBuiltinESMExports();
  `);
  signalPreload = path.join(tempDir, "spawn-signal.cjs");
  fs.writeFileSync(signalPreload, `
    require("node:child_process").spawnSync = () => ({ status: null, signal: "SIGTERM" });
    require("node:module").syncBuiltinESMExports();
  `);
});

afterAll(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
});

function launch(suite, { args = [], exitCode = 0, preload } = {}) {
  const result = spawnSync(process.execPath, [
    ...(preload ? ["--require", preload] : []), launcher, suite, ...args,
  ], {
    cwd: invocationDir,
    env: {
      ...process.env,
      RUN_REAL: "0", RUN_MIMO_FREE_LIVE_TESTS: "0", RUN_E2E: "0",
      LAUNCHER_SENTINEL: "inherited-value",
      LAUNCHER_STUB_EXIT: String(exitCode),
    },
    encoding: "utf8",
    timeout: 10_000,
  });
  expect(result.error).toBeUndefined();
  return result;
}

function childOutput(result) {
  const line = result.stdout.split(/\r?\n/).find((line) => line.startsWith(childPrefix));
  expect(line, result.stderr || "expected the fixture child to run").toBeDefined();
  return JSON.parse(line.slice(childPrefix.length));
}

describe("test suite launcher", () => {
  it.each([
    ["live", { RUN_REAL: "1", RUN_MIMO_FREE_LIVE_TESTS: "1", RUN_E2E: "0" }],
    ["e2e", { RUN_REAL: "0", RUN_MIMO_FREE_LIVE_TESTS: "0", RUN_E2E: "1" }],
  ])("launches %s with its flags, config, arguments and working directory", (suite, flags) => {
    const args = ["unit/selected.test.js", "--testNamePattern", "a name with spaces"];
    const result = launch(suite, { args });
    expect(result.status).toBe(0);
    const child = childOutput(result);
    expect(child.args).toEqual([
      "run", "--config", `./vitest.${suite}.config.js`, "--reporter=verbose", ...args,
    ]);
    expect(fs.realpathSync(child.cwd)).toBe(fs.realpathSync(testsDir));
    expect(child.env).toEqual({ ...flags, LAUNCHER_SENTINEL: "inherited-value" });
  });

  it.each(["live", "e2e"])("propagates a failing %s child's exit code", (suite) => {
    const result = launch(suite, { exitCode: 7 });
    childOutput(result);
    expect(result.status).toBe(7);
  });

  it("reports spawn errors and exits unsuccessfully", () => {
    const result = launch("live", { preload: spawnErrorPreload });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("fixture spawn failure");
    expect(result.stdout).not.toContain(childPrefix);
  });

  it("exits unsuccessfully when the child is terminated by a signal", () => {
    expect(launch("e2e", { preload: signalPreload }).status).toBe(1);
  });

  it("rejects an unknown suite without starting the child", () => {
    const result = launch("unknown");
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Expected suite: live or e2e");
    expect(result.stdout).not.toContain(childPrefix);
  });
});
