import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildSamlAuthorizeUrl,
  getSamlRequestCache,
  SAML_MAX_PENDING_REQUESTS,
  SAML_REQUEST_TTL_MS,
} from "../../src/lib/auth/saml.js";

const CACHE_KEY = Symbol.for("10router.samlRequestCache");
const settings = { samlCert: "test-certificate", samlEntryPoint: "https://idp.example.com/sso", samlIssuer: "urn:9router:sp", baseUrl: "https://dashboard.example.com" };

async function issue(s = settings) {
  const { requestId } = await buildSamlAuthorizeUrl(null, s);
  expect(requestId).toBeTruthy();
  return requestId;
}

async function spam(prefix, count) {
  const cache = getSamlRequestCache();
  for (let i = 0; i < count; i++) await cache.saveAsync(`${prefix}-${i}`, "t");
}

beforeEach(() => {
  delete globalThis[CACHE_KEY];
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
  delete globalThis[CACHE_KEY];
});

describe("SAML pending request store", () => {
  it("is one store for the whole process, whichever IdP issued the request", async () => {
    const first = await issue();
    const second = await issue({ ...settings, samlEntryPoint: "https://other-idp.example.com/sso", samlCert: "other-cert" });
    expect(getSamlRequestCache()).toBe(getSamlRequestCache());
    expect(await getSamlRequestCache().getAsync(first)).not.toBeNull();
    expect(await getSamlRequestCache().getAsync(second)).not.toBeNull();
  });

  it("keeps a fresh request ID while /start spam fills the store", async () => {
    await spam("old", SAML_MAX_PENDING_REQUESTS);
    vi.setSystemTime(Date.now() + SAML_REQUEST_TTL_MS + 1);
    const fresh = await issue();
    await spam("new", SAML_MAX_PENDING_REQUESTS - 1);

    const cache = getSamlRequestCache();
    expect(await cache.getAsync(fresh)).not.toBeNull();
    expect(await cache.getAsync("old-0")).toBeNull();
    expect(await cache.getAsync(`new-${SAML_MAX_PENDING_REQUESTS - 2}`)).toBe("t");
  });

  it("drops the oldest live request ID once the store is full", async () => {
    await spam("live", SAML_MAX_PENDING_REQUESTS + 1);
    const cache = getSamlRequestCache();
    expect(await cache.getAsync("live-0")).toBeNull();
    expect(await cache.getAsync("live-1")).toBe("t");
    expect(await cache.getAsync(`live-${SAML_MAX_PENDING_REQUESTS}`)).toBe("t");
  });

  it("forgets a request ID after 10 minutes", async () => {
    const id = await issue();
    const cache = getSamlRequestCache();
    vi.setSystemTime(Date.now() + SAML_REQUEST_TTL_MS - 1000);
    expect(await cache.getAsync(id)).not.toBeNull();
    vi.setSystemTime(Date.now() + 1001);
    expect(await cache.getAsync(id)).toBeNull();
  });

  it("removes a request ID once answered", async () => {
    const id = await issue();
    const cache = getSamlRequestCache();
    expect(await cache.removeAsync(id)).toBe(id);
    expect(await cache.getAsync(id)).toBeNull();
    expect(await cache.removeAsync(id)).toBeNull();
    expect(await cache.removeAsync(null)).toBeNull();
  });
});
