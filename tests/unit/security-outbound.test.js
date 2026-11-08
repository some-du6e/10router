import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const lookupMock = vi.hoisted(() => vi.fn());
vi.mock("node:dns/promises", () => ({ lookup: (...a) => lookupMock(...a) }));

import { resolveBaseUrl, buildSearchRequest } from "../../open-sse/handlers/search/callers.js";
import { isBlockedIpAddress } from "../../open-sse/utils/ssrfGuard.js";
import { fetchImageAsBase64 } from "../../open-sse/translator/concerns/image.js";
import cloudflareAi from "../../open-sse/handlers/imageProviders/cloudflareAi.js";
import { KiroExecutor } from "../../open-sse/executors/kiro.js";
import { normalizeKiroExternalIdpAuth } from "../../src/lib/oauth/kiroExternalIdp.js";
import { normalizeGitlabBaseUrl } from "../../src/lib/oauth/gitlabBaseUrl.js";
import { relayKeyCheck, withRelayKey, newRelayKey } from "../../src/lib/network/relayKey.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const realFetch = globalThis.fetch;

beforeEach(() => {
  lookupMock.mockReset();
  lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
});
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

describe("search provider_options.baseUrl", () => {
  const TAVILY = { id: "tavily", baseUrl: "https://api.tavily.com/search" };

  it("refuses a client base URL when the operator's key would be attached", () => {
    const params = { query: "q", maxResults: 5, token: "tvly-operator", providerOptions: { baseUrl: "https://attacker.example" } };
    expect(() => buildSearchRequest(TAVILY, params)).toThrow(/not allowed/);
    expect(() => resolveBaseUrl(TAVILY, params)).toThrow(/not allowed/);
  });

  it("keeps the operator-configured base URL for credentialed providers", () => {
    const params = { token: "k", providerSpecificData: { baseUrl: "https://proxy.example.com/search" } };
    expect(resolveBaseUrl(TAVILY, params)).toBe("https://proxy.example.com/search");
  });

  it("still lets keyless providers take a public override", () => {
    const params = { providerOptions: { baseUrl: "https://my-searxng.example.com" } };
    expect(resolveBaseUrl({ id: "searxng", baseUrl: "https://s.example" }, params)).toBe("https://my-searxng.example.com");
  });
});

describe("image prefetch address check", () => {
  it("treats the IPv6 unspecified address and embedded internal IPv4 as internal", () => {
    for (const ip of ["::", "0:0:0:0:0:0:0:0", "::ffff:127.0.0.1", "64:ff9b::7f00:1", "2002:7f00:1::", "fec0::1", "127.0.0.1", "10.1.2.3"]) {
      expect(isBlockedIpAddress(ip), ip).toBe(true);
    }
    expect(isBlockedIpAddress("93.184.216.34")).toBe(false);
    expect(isBlockedIpAddress("2606:4700::1111")).toBe(false);
  });

  it("refuses a host that resolves to ::", async () => {
    lookupMock.mockResolvedValue([{ address: "::", family: 6 }]);
    globalThis.fetch = vi.fn();
    expect(await fetchImageAsBase64("http://rebind.example/x.png")).toBeNull();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

describe("cloudflare-ai image inputs", () => {
  it("rejects an internal image or mask URL without fetching it", async () => {
    lookupMock.mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
    globalThis.fetch = vi.fn();
    await expect(cloudflareAi.buildBody("@cf/m", { prompt: "p", image: "http://127.0.0.1:8080/x.png" })).rejects.toThrow(/not allowed/);
    await expect(cloudflareAi.buildBody("@cf/m", { prompt: "p", mask: "http://localhost/m.png" })).rejects.toThrow(/not allowed/);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("still inlines a public image", async () => {
    globalThis.fetch = vi.fn(async () => new Response(PNG, { status: 200 }));
    const body = await cloudflareAi.buildBody("@cf/m", { prompt: "p", image: "https://cdn.example.com/a.png" });
    expect(body.image_b64).toBe(PNG.toString("base64"));
  });
});

describe("kiro region", () => {
  const base = {
    auth_method: "external_idp",
    access_token: "a.b.c",
    refresh_token: "r",
    client_id: "c",
    token_endpoint: "https://login.microsoftonline.com/t/oauth2/v2.0/token",
    profile_arn: "arn:aws:codewhisperer:us-east-1:123456789012:profile/ABC",
    scopes: "s",
  };

  it("rejects a non-AWS region on import", () => {
    for (const region of ["attacker.example/#", "eu-west-1.evil.com", "us-east-1@x", "a/b"]) {
      expect(() => normalizeKiroExternalIdpAuth({ ...base, region }), region).toThrow(/Invalid region/);
    }
    expect(normalizeKiroExternalIdpAuth({ ...base, region: "eu-central-1" }).providerSpecificData.region).toBe("eu-central-1");
  });

  it("never lets a stored region change the upstream host", () => {
    const executor = new KiroExecutor();
    const urls = executor.getOrderedBaseUrls({ providerSpecificData: { authMethod: "external_idp", region: "x.attacker.example/#" } });
    for (const u of urls) expect(new URL(u).hostname).toMatch(/\.(amazonaws\.com|kiro\.dev)$/);
    const eu = executor.getOrderedBaseUrls({ providerSpecificData: { authMethod: "external_idp", region: "eu-central-1" } });
    expect(eu.some((u) => u.includes(".eu-central-1.amazonaws.com"))).toBe(true);
  });
});

describe("gitlab base URL", () => {
  it("accepts instance URLs and rejects ones that would swallow the API path", () => {
    expect(normalizeGitlabBaseUrl(undefined)).toBe("https://gitlab.com");
    expect(normalizeGitlabBaseUrl(" https://git.example.com/gitlab/ ")).toBe("https://git.example.com/gitlab");
    expect(normalizeGitlabBaseUrl("http://192.168.1.5:8080")).toBe("http://192.168.1.5:8080");
    for (const bad of ["https://x.example/?", "https://x.example#", "ftp://x.example", "https://u:p@x.example", "not a url", 5]) {
      expect(normalizeGitlabBaseUrl(bad), String(bad)).toBeNull();
    }
  });
});

describe("relay key", () => {
  const run = (key, url) => new Function("request", `${relayKeyCheck(key, "request")}\nreturn "forwarded";`)({ url });

  it("relay code refuses callers without the key", () => {
    const key = newRelayKey();
    expect(run(key, "https://relay.example/").status).toBe(403);
    expect(run(key, "https://relay.example/?relay_key=wrong").status).toBe(403);
    expect(run(key, withRelayKey("https://relay.example", key))).toBe("forwarded");
  });
});
