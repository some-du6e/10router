import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import dns from "node:dns";

// The image fetch is undici's own fetch, with the connection pinned to the checked address.
const undiciFetch = vi.hoisted(() => vi.fn());
vi.mock("undici", async (orig) => ({ ...(await orig()), fetch: (...a) => undiciFetch(...a) }));

import { fetchImageAsBase64 } from "../../open-sse/translator/concerns/image.js";

// Control which host resolves to what IP (the SSRF guard's one lookup).
let lookupMock;

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function mockFetchOnce(bytes, ok = true) {
  const body = {
    getReader() {
      let sent = false;
      return {
        read: async () => sent ? { done: true } : (sent = true, { done: false, value: new Uint8Array(bytes) }),
        cancel: async () => {},
      };
    },
  };
  undiciFetch.mockImplementation(async () => ({ ok, body }));
}

beforeEach(() => {
  undiciFetch.mockReset();
  lookupMock = vi.spyOn(dns.promises, "lookup").mockResolvedValue([{ address: "93.184.216.34", family: 4 }]); // public by default
});
afterEach(() => { vi.restoreAllMocks(); });

describe("fetchImageAsBase64 hardening", () => {
  it("rejects non-http url", async () => {
    expect(await fetchImageAsBase64("ftp://x/y.png")).toBeNull();
    expect(await fetchImageAsBase64("data:image/png;base64,xx")).toBeNull();
  });

  it("SSRF: rejects private IP (10.x)", async () => {
    lookupMock.mockResolvedValue([{ address: "10.0.0.5", family: 4 }]);
    expect(await fetchImageAsBase64("http://internal.example/x.png")).toBeNull();
  });

  it("SSRF: rejects cloud metadata 169.254.169.254", async () => {
    lookupMock.mockResolvedValue([{ address: "169.254.169.254", family: 4 }]);
    expect(await fetchImageAsBase64("http://metadata/x.png")).toBeNull();
  });

  it("SSRF: rejects blocked hostname localhost", async () => {
    expect(await fetchImageAsBase64("http://localhost/x.png")).toBeNull();
  });

  it("SSRF: rejects IPv6 loopback", async () => {
    lookupMock.mockResolvedValue([{ address: "::1", family: 6 }]);
    expect(await fetchImageAsBase64("http://x/y.png")).toBeNull();
  });

  it("accepts valid PNG from public host", async () => {
    mockFetchOnce(PNG);
    const r = await fetchImageAsBase64("https://example.com/a.png");
    expect(r).not.toBeNull();
    expect(r.mimeType).toBe("image/png");
    expect(r.url.startsWith("data:image/png;base64,")).toBe(true);
  });

  it("rejects disguised non-image payload (magic byte mismatch)", async () => {
    mockFetchOnce(Buffer.from("<?php system($_GET[c]); ?>"));
    expect(await fetchImageAsBase64("https://example.com/evil.png")).toBeNull();
  });

  it("rejects payload over size cap", async () => {
    mockFetchOnce(Buffer.alloc(1024));
    expect(await fetchImageAsBase64("https://example.com/big.png", { maxBytes: 100 })).toBeNull();
  });

  it("returns null when fetch not ok", async () => {
    mockFetchOnce(PNG, false);
    expect(await fetchImageAsBase64("https://example.com/404.png")).toBeNull();
  });

  it("pins the connection: undici's fetch gets a dispatcher and never follows redirects itself", async () => {
    mockFetchOnce(PNG);
    expect(await fetchImageAsBase64("https://example.com/a.png")).not.toBeNull();
    const init = undiciFetch.mock.calls[0][1];
    expect(init.dispatcher).toBeDefined();
    expect(init.redirect).toBe("manual");
    expect(lookupMock).toHaveBeenCalledTimes(1);
  });

  it("fails closed when the name doesn't resolve", async () => {
    lookupMock.mockRejectedValue(Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" }));
    mockFetchOnce(PNG);
    expect(await fetchImageAsBase64("https://nowhere.example/a.png")).toBeNull();
    expect(undiciFetch).not.toHaveBeenCalled();
  });

  it("takes an upper-case scheme", async () => {
    mockFetchOnce(PNG);
    expect(await fetchImageAsBase64("HTTPS://example.com/a.png")).not.toBeNull();
  });

  it("follows a redirect only when allowed, checking the new host again", async () => {
    const redirect = (location) => ({ ok: false, status: 302, headers: new Headers({ location }), body: { cancel: async () => {} } });
    undiciFetch.mockResolvedValueOnce(redirect("https://cdn2.example.com/a.png"));
    expect(await fetchImageAsBase64("https://example.com/a.png")).toBeNull();
    expect(undiciFetch).toHaveBeenCalledTimes(1);

    undiciFetch.mockReset();
    undiciFetch.mockResolvedValueOnce(redirect("http://10.0.0.9/a.png"));
    expect(await fetchImageAsBase64("https://example.com/a.png", { maxRedirects: 3 })).toBeNull();
    expect(undiciFetch).toHaveBeenCalledTimes(1);
  });

  it("follows an allowed redirect to another public host, resolving and pinning it too", async () => {
    const redirect = { ok: false, status: 302, headers: new Headers({ location: "https://cdn2.example.com/a.png" }), body: { cancel: async () => {} } };
    undiciFetch.mockResolvedValueOnce(redirect);
    const png = { ok: true, status: 200, headers: new Headers(), body: { getReader: () => { let sent = false; return { read: async () => (sent ? { done: true } : (sent = true, { done: false, value: new Uint8Array(PNG) })), cancel: async () => {} }; } } };
    undiciFetch.mockResolvedValueOnce(png);
    const r = await fetchImageAsBase64("https://example.com/a.png", { maxRedirects: 3 });
    expect(r?.mimeType).toBe("image/png");
    expect(undiciFetch).toHaveBeenCalledTimes(2);
    expect(undiciFetch.mock.calls[1][0]).toBe("https://cdn2.example.com/a.png");
    expect(undiciFetch.mock.calls[1][1].dispatcher).toBeDefined();
    expect(lookupMock.mock.calls.map((c) => c[0])).toEqual(["example.com", "cdn2.example.com"]);
  });
});
