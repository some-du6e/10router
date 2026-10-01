import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("../../src/models/index.js", () => ({ getProviderNodeById: vi.fn() }));
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: mocks.fetch }));

import { POST } from "../../src/app/api/providers/validate/route.js";

beforeEach(() => vi.resetAllMocks());

describe("System One API-key validation", () => {
  it.each([200, 400, 401, 403])("checks the native Zen endpoint for HTTP %i", async (status) => {
    mocks.fetch.mockResolvedValue(new Response("{}", { status }));
    const proxy = { proxyUrl: "http://localhost:8080" };
    const response = await POST(new Request("http://localhost/api/providers/validate", {
      method: "POST",
      body: JSON.stringify({ provider: "opencode-zen", apiKey: "test-key", providerSpecificData: proxy }),
    }));
    expect(response.status).toBe(200);
    expect((await response.json()).valid).toBe(status !== 401 && status !== 403);
    const [url, options, connectionData] = mocks.fetch.mock.calls[0];
    expect(url).toBe("https://opencode.ai/zen/v1/systemone");
    expect(options.headers.Authorization).toBe("Bearer test-key");
    expect(options.headers["x-opencode-session"]).toMatch(/^ses_/);
    expect(JSON.parse(options.body)).toMatchObject({ model: "jev-1.13", questions: { probe: { type: "noul" } } });
    expect(connectionData).toEqual(proxy);
  });
});
