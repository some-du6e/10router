import { describe, it, expect, vi } from "vitest";

const fetchMock = vi.hoisted(() => vi.fn(async () => new Response(JSON.stringify({ models: [] }), { status: 200 })));
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: fetchMock }));

const { KIMCHI_API, resolveKimchiModels } = await import("../../open-sse/services/kimchiModels.js");

describe("Kimchi model catalog", () => {
  it("sends the token to Kimchi's own API, whatever a connection's stored data names", async () => {
    await resolveKimchiModels({ accessToken: "tok", providerSpecificData: { kimchiEndpoint: "https://elsewhere.example" } }, { forceRefresh: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(new URL(url).origin).toBe(new URL(KIMCHI_API).origin);
    expect(init.headers.Authorization).toBe("Bearer tok");
  });
});
