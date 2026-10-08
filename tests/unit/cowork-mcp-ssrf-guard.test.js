/**
 * SSRF guard on POST /api/cli-tools/cowork-mcp-tools (#3782).
 *
 * Remote callers must not be able to force server-side fetches to
 * internal URLs; local-host use (self-hosted MCP servers) keeps working.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import dns from "node:dns";

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body, init) =>
      new Response(JSON.stringify(body), {
        status: init?.status ?? 200,
        headers: { "content-type": "application/json" },
      }),
  },
}));

const { POST } = await import(
  "../../src/app/api/cli-tools/cowork-mcp-tools/route.js"
);

function remoteRequest(url) {
  return new Request("http://gateway.example.com/api/cli-tools/cowork-mcp-tools", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url }),
  });
}

describe("cowork-mcp-tools SSRF guard", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects loopback URLs from remote callers without fetching", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const res = await POST(remoteRequest("http://127.0.0.1:18731/internal-admin"));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "URL not allowed" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects private-network URLs from remote callers", async () => {
    for (const url of ["http://10.0.0.5/mcp", "http://192.168.1.1/mcp", "http://localhost:3000/mcp"]) {
      const res = await POST(remoteRequest(url));
      expect(res.status, `should reject ${url}`).toBe(400);
    }
  });

  it("still requires a url", async () => {
    const res = await POST(
      new Request("http://gateway.example.com/api/cli-tools/cowork-mcp-tools", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      })
    );
    expect(res.status).toBe(400);
  });

  it("rejects public-looking hosts that resolve to a private address", async () => {
    vi.spyOn(dns.promises, "lookup").mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    expect((await POST(remoteRequest("https://mcp.example.test"))).status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("blocks redirects to internal targets", async () => {
    vi.spyOn(dns.promises, "lookup").mockResolvedValue([{ address: "8.8.8.8", family: 4 }]);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 307, headers: { location: "http://127.0.0.1/admin" } }));
    const response = await POST(remoteRequest("https://mcp.example.test"));
    expect((await response.json()).error).toContain("Blocked URL");
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(fetchSpy.mock.calls[0][1].redirect).toBe("manual");
  });
});
