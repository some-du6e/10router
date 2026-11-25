import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/models/index.js", () => ({ getProviderNodeById: vi.fn(), getCustomModels: vi.fn() }));

import { POST } from "../../src/app/api/providers/validate/route.js";

afterEach(() => vi.unstubAllGlobals());

function stubFetch(status) {
  const fetchMock = vi.fn(async () => new Response("{}", { status }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function validate(provider, apiKey) {
  const response = await POST(new Request("http://localhost/api/providers/validate", {
    method: "POST",
    body: JSON.stringify({ provider, apiKey }),
  }));
  return response.json();
}

describe("web search key checks", () => {
  it.each([[200, true], [401, false], [403, false]])(
    "checks a Hack Club AI key with a GET that runs no search (HTTP %i)",
    async (status, valid) => {
      const fetchMock = stubFetch(status);
      expect((await validate("hackclub-exa", "hc-key")).valid).toBe(valid);
      expect(fetchMock).toHaveBeenCalledOnce();
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe("https://ai.hackclub.com/proxy/v1/stats");
      expect(init.method).toBe("GET");
      expect(init.body).toBeUndefined();
      expect(init.headers.Authorization).toBe("Bearer hc-key");
    },
  );

  it("still checks an Exa key with a search", async () => {
    const fetchMock = stubFetch(401);
    expect((await validate("exa", "exa-key")).valid).toBe(false);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.exa.ai/search");
    expect(init.method).toBe("POST");
    expect(init.headers["x-api-key"]).toBe("exa-key");
  });
});
