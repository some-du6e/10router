import { afterEach, describe, expect, it, vi } from "vitest";
import api from "@/shared/utils/api.js";

afterEach(() => vi.unstubAllGlobals());

describe("dashboard API requests", () => {
  it.each([
    ["get", "GET"], ["post", "POST"], ["put", "PUT"], ["patch", "PATCH"], ["del", "DELETE"],
  ])("sends %s as %s and merges custom headers", async (method, httpMethod) => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ saved: true }));
    vi.stubGlobal("fetch", fetch);
    const options = { headers: { Authorization: "Bearer local-test" } };
    if (["post", "put", "patch"].includes(method)) await api[method]("/api/example", { value: 1 }, options);
    else await api[method]("/api/example", options);
    const [, init] = fetch.mock.calls[0];
    expect(init.method).toBe(httpMethod);
    const headers = new Headers(init.headers);
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("authorization")).toBe("Bearer local-test");
  });

  it("sends the JSON body for patch", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({}));
    vi.stubGlobal("fetch", fetch);
    await api.patch("/api/example", { value: 1 });
    expect(fetch.mock.calls[0][1].body).toBe(JSON.stringify({ value: 1 }));
  });

  it("keeps the default content type when the override is a Headers object", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({}));
    vi.stubGlobal("fetch", fetch);
    await api.get("/api/example", { headers: new Headers({ Authorization: "Bearer local-test" }) });
    const headers = new Headers(fetch.mock.calls[0][1].headers);
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("authorization")).toBe("Bearer local-test");
  });

  it("lets a Headers override replace the content type", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({}));
    vi.stubGlobal("fetch", fetch);
    await api.get("/api/example", { headers: new Headers({ "Content-Type": "application/custom" }) });
    expect(new Headers(fetch.mock.calls[0][1].headers).get("content-type")).toBe("application/custom");
  });

  it("preserves HTTP status when the error body is not JSON", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("Unavailable", { status: 503 })));
    await expect(api.get("/api/example")).rejects.toMatchObject({ status: 503, message: "Request failed (503)", data: null });
  });

  it("reads structured upstream errors", async () => {
    const data = { error: { message: "Rate limited" } };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(data, { status: 429 })));
    await expect(api.get("/api/example")).rejects.toMatchObject({ message: "Rate limited", status: 429, data });
  });

  it("accepts a successful empty delete response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
    await expect(api.del("/api/example")).resolves.toBeNull();
  });
});
