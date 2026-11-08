import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (rel) => readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), "utf8");

describe("third-party analytics stays off OAuth credentials", () => {
  it("renders Google Analytics only for an operator-set measurement ID", () => {
    const layout = read("src/app/layout.js");
    expect(layout).not.toMatch(/["']G-[A-Z0-9]{6,}["']/);
    expect(layout).toMatch(/process\.env\.NEXT_PUBLIC_GA_ID/);
    expect(layout).toMatch(/GA_ID \? <GoogleAnalytics gaId=\{GA_ID\} \/> : null/);
  });

  it("strips credential-bearing query params from the /callback URL once read", () => {
    const page = read("src/app/callback/page.js");
    expect(page).toMatch(/if \(code \|\| token \|\| error\) window\.history\.replaceState\(null, "", window\.location\.pathname\)/);
  });
});
