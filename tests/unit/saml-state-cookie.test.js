import { describe, expect, it, vi } from "vitest";

vi.stubEnv("JWT_SECRET", "secret-a");
const { createSamlStateCookie, readSamlStateCookie, SAML_REQUEST_TTL_MS } = await import("../../src/lib/auth/saml.js");

const NOW = Date.UTC(2026, 0, 1);

describe("signed saml_state cookie", () => {
  it("names the request it was issued for until it expires", () => {
    const cookie = createSamlStateCookie("_req-1", NOW);
    expect(readSamlStateCookie(cookie, NOW)).toEqual({ id: "_req-1", exp: NOW + SAML_REQUEST_TTL_MS });
    expect(readSamlStateCookie(cookie, NOW + SAML_REQUEST_TTL_MS - 1)).toEqual(expect.objectContaining({ id: "_req-1" }));
    expect(readSamlStateCookie(cookie, NOW + SAML_REQUEST_TTL_MS)).toBeNull();
  });

  it("rejects a cookie whose request ID or expiry was changed", () => {
    const [, signature] = createSamlStateCookie("_req-1", NOW).split(".");
    const swapped = Buffer.from(JSON.stringify({ id: "_req-2", exp: NOW + SAML_REQUEST_TTL_MS })).toString("base64url");
    const extended = Buffer.from(JSON.stringify({ id: "_req-1", exp: NOW + 10 * SAML_REQUEST_TTL_MS })).toString("base64url");
    expect(readSamlStateCookie(`${swapped}.${signature}`, NOW)).toBeNull();
    expect(readSamlStateCookie(`${extended}.${signature}`, NOW)).toBeNull();
  });

  it("rejects a cookie signed with another secret", async () => {
    vi.resetModules();
    vi.stubEnv("JWT_SECRET", "secret-b");
    const other = await import("../../src/lib/auth/saml.js");
    const cookie = other.createSamlStateCookie("_req-1", NOW);
    // Back to this module's secret before it reads, whichever test ran first.
    vi.stubEnv("JWT_SECRET", "secret-a");
    expect(readSamlStateCookie(createSamlStateCookie("_req-1", NOW), NOW)).not.toBeNull();
    expect(readSamlStateCookie(cookie, NOW)).toBeNull();
  });

  it.each([undefined, null, "", "_req-1", ".", "abc.", ".abc", "not-base64.%%%"])("rejects %s", (value) => {
    expect(readSamlStateCookie(value, NOW)).toBeNull();
  });

  it("rejects a correctly signed cookie with an empty request ID", () => {
    const cookie = createSamlStateCookie("", NOW);
    expect(readSamlStateCookie(cookie, NOW)).toBeNull();
  });
});
