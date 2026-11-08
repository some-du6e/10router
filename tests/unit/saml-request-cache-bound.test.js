import { describe, expect, it } from "vitest";
import { InMemoryCacheProvider } from "@node-saml/node-saml";
import { boundedCache, SAML_MAX_PENDING_REQUESTS } from "../../src/lib/auth/saml.js";

describe("SAML request cache bound", () => {
  it("evicts the oldest request IDs past the cap and keeps the newest", async () => {
    const cache = boundedCache(new InMemoryCacheProvider({ keyExpirationPeriodMs: 60_000 }));
    for (let i = 0; i <= SAML_MAX_PENDING_REQUESTS; i++) await cache.saveAsync(`id-${i}`, "t");
    expect(await cache.getAsync("id-0")).toBeNull();
    expect(await cache.getAsync("id-1")).toBe("t");
    expect(await cache.getAsync(`id-${SAML_MAX_PENDING_REQUESTS}`)).toBe("t");
  });

  it("keeps single-use removal working", async () => {
    const cache = boundedCache(new InMemoryCacheProvider({ keyExpirationPeriodMs: 60_000 }));
    await cache.saveAsync("id", "t");
    await cache.removeAsync("id");
    expect(await cache.getAsync("id")).toBeNull();
  });
});
