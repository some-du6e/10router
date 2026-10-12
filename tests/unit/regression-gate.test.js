import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { afterAll, describe, expect, it } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "10router-regression-gate-"));
const gate = fileURLToPath(new URL("../__baseline__/verify-no-regression.mjs", import.meta.url));
const historical = JSON.parse(readFileSync(new URL("../__baseline__/baseline-results.json", import.meta.url), "utf8"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function check(report) {
  const path = join(dir, "results.json");
  writeFileSync(path, JSON.stringify(report));
  return spawnSync(process.execPath, [gate, path], { encoding: "utf8" });
}

function passingReport() {
  return {
    numTotalTests: 1, numFailedTests: 0, numFailedTestSuites: 0, success: true,
    testResults: [{ name: fileURLToPath(new URL("./regression-gate.test.js", import.meta.url)),
      status: "passed", message: "", assertionResults: [{ fullName: "fixture passes", status: "passed" }] }],
  };
}

describe("regression gate", () => {
  it("rejects the real historical cloud import failure even with no failed assertions", () => {
    const report = passingReport();
    const failure = historical.testResults.find((suite) => suite.name.endsWith("/unit/embeddings.cloud.test.js"));
    expect(failure.assertionResults).toHaveLength(0);
    report.testResults.push(failure);
    report.numFailedTestSuites = 1;
    report.success = false;
    const result = check(report);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("embeddings.cloud.test.js");
  });

  it("rejects a restored historical failure that has since been fixed", () => {
    const report = passingReport();
    const suite = historical.testResults.find((suite) => suite.name.endsWith("/unit/oauth-cursor-auto-import.test.js"));
    const failure = suite.assertionResults.find((test) => test.status === "failed");
    report.testResults = [{ ...suite, assertionResults: [failure] }];
    report.numFailedTests = 1;
    report.numFailedTestSuites = 1;
    report.success = false;
    expect(check(report).status).toBe(1);
  });

  it("rejects an empty test run", () => {
    expect(check({ ...passingReport(), numTotalTests: 0, testResults: [] }).status).not.toBe(0);
  });

  it("rejects runner errors even when all assertions pass", () => {
    expect(check({ ...passingReport(), success: false }).status).toBe(1);
  });

  it("accepts a complete passing report", () => {
    expect(check(passingReport()).status).toBe(0);
  });
});
