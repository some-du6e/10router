// The endpoint page's Re-detect box must use the tested helpers in
// redetectText.ts (the tests have no DOM, so this reads the page's source).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

const page = readFileSync(fileURLToPath(new URL("../../src/app/(dashboard)/dashboard/providers/[id]/CustomEndpointPage.tsx", import.meta.url)), "utf8");

describe("Re-detect box wiring", () => {
  it.each([
    ["the default ticks", /useState\(\(\) => defaultPick\(diff\)\)/],
    ["the red box's text", /\{failedText\(diff\)\}/],
    ["the fixes row", /const qList = fixesList\(q\);/],
    ["the summary line", /\{summaryText\(part, diff\)\}/],
  ])("uses the helper for %s", (_what, call) => {
    expect(page).toMatch(call);
  });
});
