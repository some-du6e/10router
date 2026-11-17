import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseGaMeasurementId } from "../../src/shared/utils/gaMeasurementId.mjs";
import Analytics from "../../src/shared/components/Analytics.tsx";

const nav = vi.hoisted(() => ({ pathname: "/dashboard" }));
vi.mock("next/navigation", () => ({ usePathname: () => nav.pathname }));
// Stands in for the real tag, which loads gtag with the page URL.
vi.mock("@next/third-parties/google", async () => {
  const { createElement: h } = await import("react");
  return { GoogleAnalytics: ({ gaId }) => h("span", { "data-ga-id": gaId }) };
});

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const read = (rel) => readFileSync(path.join(repoRoot, rel), "utf8");
const render = (pathname, gaId) => {
  nav.pathname = pathname;
  return renderToStaticMarkup(createElement(Analytics, { gaId }));
};

describe("Google Analytics measurement ID", () => {
  it.each([
    ["unset", undefined, ""],
    ["empty", "", ""],
    ["a GA4 ID", "G-TEST123", "G-TEST123"],
    ["a GA4 ID with whitespace", "  G-TEST123\n", "G-TEST123"],
    ["lowercase", "g-test123", ""],
    ["a Universal Analytics ID", "UA-1234-1", ""],
    ["a bare prefix", "G-", ""],
    ["an injection string", 'G-TEST123"></script><script>alert(1)</script>', ""],
    ["an ID with a space inside", "G-TEST 123", ""],
  ])("%s → %j", (_name, raw, expected) => {
    expect(parseGaMeasurementId(raw)).toBe(expected);
  });
});

describe("next.config inlines the validated ID at build time", () => {
  const CONFIG_URL = pathToFileURL(path.join(repoRoot, "next.config.mjs")).href;
  let counter = 0;
  let saved;
  const loadConfig = async () => (await import(`${CONFIG_URL}?ga=${counter++}`)).default;

  beforeEach(() => {
    saved = process.env.NEXT_PUBLIC_GA_ID;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.NEXT_PUBLIC_GA_ID;
    else process.env.NEXT_PUBLIC_GA_ID = saved;
  });

  it("defines NEXT_PUBLIC_GA_ID as the trimmed ID", async () => {
    process.env.NEXT_PUBLIC_GA_ID = " G-TEST123 ";
    expect((await loadConfig()).env.NEXT_PUBLIC_GA_ID).toBe("G-TEST123");
  });

  // An empty define still replaces process.env.NEXT_PUBLIC_GA_ID in the bundle,
  // so a value set later on the running server is never read.
  it("defines it as empty when unset or invalid", async () => {
    delete process.env.NEXT_PUBLIC_GA_ID;
    expect((await loadConfig()).env.NEXT_PUBLIC_GA_ID).toBe("");
    process.env.NEXT_PUBLIC_GA_ID = "G-TEST123'+alert(1)+'";
    expect((await loadConfig()).env.NEXT_PUBLIC_GA_ID).toBe("");
  });
});

describe("analytics tag", () => {
  it("loads on dashboard pages when an ID is set", () => {
    expect(render("/dashboard", "G-TEST123")).toBe('<span data-ga-id="G-TEST123"></span>');
    expect(render("/", "G-TEST123")).toContain("G-TEST123");
  });

  it("never loads on the OAuth callback page", () => {
    expect(render("/callback", "G-TEST123")).toBe("");
    expect(render("/callback/extra", "G-TEST123")).toBe("");
  });

  it("stays off without an ID", () => {
    expect(render("/dashboard", "")).toBe("");
  });

  it("is the only way the root layout loads Google Analytics", () => {
    const layout = read("src/app/layout.js");
    expect(layout).not.toMatch(/@next\/third-parties/);
    expect(layout).not.toMatch(/["']G-[A-Z0-9]{4,}["']/);
    expect(layout).toMatch(/<Analytics gaId=\{GA_ID\} \/>/);
  });
});

describe("Docker builds", () => {
  it("pass the measurement ID to next build", () => {
    const dockerfile = read("Dockerfile");
    const builder = dockerfile.slice(dockerfile.indexOf("AS builder"), dockerfile.indexOf("AS runner"));
    expect(builder).toMatch(/^ARG NEXT_PUBLIC_GA_ID$/m);
    expect(builder).toMatch(/^ENV NEXT_PUBLIC_GA_ID=\$NEXT_PUBLIC_GA_ID$/m);
    // Match instruction lines only; a comment above mentions `RUN npm run build`.
    const env = builder.search(/^ENV NEXT_PUBLIC_GA_ID=/m);
    const build = builder.search(/^RUN npm run build$/m);
    expect(build).toBeGreaterThan(-1);
    expect(env).toBeLessThan(build);
  });
});

// The dialog has no render test; these keep the ack from getting lost when
// handleCallback is rewritten.
describe("connect dialog wiring", () => {
  it("acks a callback only after the exchange succeeds, and replies to the popup", () => {
    const modal = read("src/shared/components/OAuthModal.js");
    expect(modal).toMatch(/if \(await exchangeTokens\(token \|\| code, state\)\) sendCallbackAck\(data, \{ reply \}\)/);
    expect(modal).toMatch(/event\.source\?\.postMessage\(ack, event\.origin\)/);
  });
});
