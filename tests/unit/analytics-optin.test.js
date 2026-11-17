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

  it("lets a Docker build pass the measurement ID to next build", () => {
    const dockerfile = read("Dockerfile");
    const builder = dockerfile.slice(dockerfile.indexOf("AS builder"), dockerfile.indexOf("AS runner"));
    expect(builder).toMatch(/^ARG NEXT_PUBLIC_GA_ID$/m);
    expect(builder).toMatch(/^ENV NEXT_PUBLIC_GA_ID=\$NEXT_PUBLIC_GA_ID$/m);
    expect(builder.indexOf("ENV NEXT_PUBLIC_GA_ID")).toBeLessThan(builder.indexOf("RUN npm run build"));
  });

  it("strips the /callback query only once the dashboard says it took the callback", () => {
    const page = read("src/app/callback/page.js");
    const ackListener = page.indexOf("listenForCallbackAck(() => {");
    expect(ackListener).toBeGreaterThan(-1);
    // Every replaceState sits inside the ack handler, after the listener opens.
    const strips = [...page.matchAll(/window\.history\.replaceState\(/g)].map((m) => m.index);
    expect(strips).toHaveLength(1);
    expect(strips[0]).toBeGreaterThan(ackListener);
    // Without an ack the page shows the URL it captured, so the code isn't lost.
    expect(page).toMatch(/setManualUrl\(fullUrl\)/);
    expect(page).toMatch(/<code className="text-xs break-all">\{manualUrl\}<\/code>/);
  });

  it("has the connect dialog acknowledge a callback it took", () => {
    const modal = read("src/shared/components/OAuthModal.js");
    expect(modal.match(/sendCallbackAck\(\)/g)).toHaveLength(2);
  });
});
