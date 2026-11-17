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
import { regionFromProfileArn } from "../../open-sse/services/kiroModels.js";
import gitlabOAuth from "../../src/lib/oauth/providers/gitlab.js";
import { fetchImageOnce, prefetchRemoteImages } from "../../open-sse/translator/concerns/prefetch.js";
import { CodexExecutor } from "../../open-sse/executors/codex.js";
import { redactUrlSecrets } from "../../open-sse/utils/redact.js";

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

// The request-scoped download cache (fetchImageOnce) and the Codex executor's
// own download both sit on fetchImageAsBase64, so neither skips its checks.
describe("every image download path", () => {
  const imageBody = (url) => ({ messages: [{ role: "user", content: [{ type: "image_url", image_url: { url } }] }] });

  it("fetchImageOnce checks an internal host again on each attempt, never caching it", async () => {
    lookupMock.mockResolvedValue([{ address: "10.0.0.7", family: 4 }]);
    globalThis.fetch = vi.fn(async () => new Response(PNG, { status: 200 }));
    const cacheKey = new AbortController().signal;
    expect(await fetchImageOnce("http://lan.example/a.png", { cacheKey })).toBeNull();
    expect(await fetchImageOnce("http://lan.example/a.png", { cacheKey })).toBeNull();
    expect(lookupMock).toHaveBeenCalledTimes(2);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("fetchImageOnce does not follow a redirect", async () => {
    globalThis.fetch = vi.fn(async () => new Response(null, { status: 302, headers: { location: "http://127.0.0.1/a.png" } }));
    expect(await fetchImageOnce("https://cdn.example.com/a.png", { cacheKey: {} })).toBeNull();
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(globalThis.fetch.mock.calls[0][1].redirect).toBe("manual");
  });

  it("prefetch for an inline-only target leaves an internal image URL as it is", async () => {
    lookupMock.mockResolvedValue([{ address: "::", family: 6 }]);
    globalThis.fetch = vi.fn();
    const body = imageBody("http://cam.example/x.png");
    expect(await prefetchRemoteImages(body, "openai", "gemini", { cacheKey: {} })).toBe(0);
    expect(body.messages[0].content[0].image_url.url).toBe("http://cam.example/x.png");
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("the Codex executor's download refuses an internal host", async () => {
    lookupMock.mockResolvedValue([{ address: "::ffff:169.254.169.254", family: 6 }]);
    globalThis.fetch = vi.fn();
    const body = { input: [{ role: "user", content: [{ type: "image_url", image_url: { url: "http://meta.example/latest" } }] }] };
    await new CodexExecutor().prefetchImages(body, new AbortController().signal);
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(body.input[0].content[0]).toMatchObject({ type: "input_image", image_url: "http://meta.example/latest" });
  });

  it("a public image cached for the request doesn't let another URL skip the check", async () => {
    globalThis.fetch = vi.fn(async () => new Response(PNG, { status: 200 }));
    const cacheKey = {};
    expect(await fetchImageOnce("https://cdn.example.com/a.png", { cacheKey })).not.toBeNull();
    lookupMock.mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
    expect(await fetchImageOnce("https://cdn.example.com/b.png", { cacheKey })).toBeNull();
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
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

  it("rejects a profile ARN whose region field isn't an AWS region", () => {
    const bad = "arn:aws:codewhisperer:x@evil.example/#:123456789012:profile/AB";
    expect(() => normalizeKiroExternalIdpAuth({ ...base, region: "us-east-1", profile_arn: bad })).toThrow(/Invalid profile_arn/);
    expect(regionFromProfileArn(bad)).toBe("us-east-1");
    expect(regionFromProfileArn("arn:aws:codewhisperer:eu-central-1:123456789012:profile/AB")).toBe("eu-central-1");
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

describe("gitlab OAuth exchange", () => {
  it("does not follow a redirect off the instance's origin", async () => {
    globalThis.fetch = vi.fn(async () => new Response(null, { status: 307, headers: { location: "http://169.254.169.254/latest" } }));
    await expect(
      gitlabOAuth.exchangeToken(gitlabOAuth.config, "code", "http://localhost/cb", "verifier", "st", { baseUrl: "https://git.example.com", remote: false })
    ).rejects.toThrow(/redirected to http:\/\/169\.254\.169\.254/);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
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

  it("is redacted where the relay URL is logged", () => {
    const key = newRelayKey();
    expect(redactUrlSecrets(withRelayKey("https://relay.example", key))).not.toContain(key);
  });
});
