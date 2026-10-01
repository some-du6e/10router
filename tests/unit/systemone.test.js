import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("../../src/lib/localDb.js", () => ({ getApiKeys: async () => [] }));
vi.mock("../../src/shared/utils/machineId.js", () => ({ getConsistentMachineId: async () => "test-machine" }));
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: (...args) => globalThis.fetch(...args) }));
import { handleSystemoneCore } from "../../open-sse/handlers/systemoneCore.js";
import { PROVIDER_MEDIA, PROVIDER_MODELS } from "../../open-sse/providers/index.js";
import { getModelsByProviderId } from "../../open-sse/config/providerModels.js";
import { pingModelByKind } from "../../src/app/api/models/test/ping.js";

const body = { model: "oc/jev-1.13-free", state: "Payment failed", questions: { urgent: { type: "noul", instructions: "Is this urgent?" } } };

afterEach(() => vi.unstubAllGlobals());

describe("System One decision routing", () => {
  it("registers free, paid and OpenRouter Jev lanes", () => {
    for (const [provider, alias, model] of [
      ["opencode", "oc", "jev-1.13-free"],
      ["opencode-zen", "ocz", "jev-1.13"],
      ["openrouter", "openrouter", "typesafe/jev-1.13"],
    ]) {
      expect(PROVIDER_MEDIA[provider].serviceKinds).toContain("systemone");
      expect(PROVIDER_MODELS[alias]).toContainEqual(expect.objectContaining({ id: model, kind: "systemone" }));
      expect(getModelsByProviderId(provider)).toContainEqual(expect.objectContaining({ id: model, kind: "systemone" }));
    }
  });

  it("passes the native payload and response through and reports usage", async () => {
    const response = { answers: { urgent: { type: "noul", noul: 0.9 } }, usage: { input_tokens: 12, output_tokens: 3 } };
    const fetchMock = vi.fn().mockResolvedValue(Response.json(response));
    vi.stubGlobal("fetch", fetchMock);
    const onRequestSuccess = vi.fn();
    const result = await handleSystemoneCore({ body, modelInfo: { provider: "opencode", model: "jev-1.13-free" }, credentials: { accessToken: "public" }, onRequestSuccess });
    expect(result.success).toBe(true);
    expect(await result.response.json()).toEqual(response);
    expect(result.usage).toEqual({ prompt_tokens: 12, completion_tokens: 3 });
    expect(onRequestSuccess).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://opencode.ai/zen/v1/systemone");
    expect(JSON.parse(init.body)).toEqual({ ...body, model: "jev-1.13-free" });
    expect(init.headers["x-opencode-session"]).toMatch(/^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
  });

  it("uses the OpenRouter key without OpenCode session headers", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ answers: {} }));
    vi.stubGlobal("fetch", fetchMock);
    await handleSystemoneCore({ body, modelInfo: { provider: "openrouter", model: "typesafe/jev-1.13" }, credentials: { apiKey: "or-key" } });
    expect(fetchMock).toHaveBeenCalledWith("https://openrouter.ai/api/v1/systemone", expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer or-key" }) }), undefined);
    expect(fetchMock.mock.calls[0][1].headers["x-opencode-session"]).toBeUndefined();
  });

  it("rejects invalid inputs and unsupported providers before fetching", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    for (const invalid of [{ ...body, state: null }, { ...body, questions: [] }]) {
      const result = await handleSystemoneCore({ body: invalid, modelInfo: { provider: "opencode", model: "jev-1.13-free" } });
      expect(result.status).toBe(400);
    }
    const unsupported = await handleSystemoneCore({ body, modelInfo: { provider: "openai", model: "gpt-6" } });
    expect(unsupported.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns upstream rate-limit and malformed-response errors", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(Response.json({ error: { message: "Quota exceeded" } }, { status: 429 })).mockResolvedValueOnce(new Response("invalid json"));
    vi.stubGlobal("fetch", fetchMock);
    const args = { body, modelInfo: { provider: "opencode", model: "jev-1.13-free" } };
    expect(await handleSystemoneCore(args)).toMatchObject({ success: false, status: 429 });
    expect(await handleSystemoneCore(args)).toMatchObject({ success: false, status: 502 });
  });

  it("passes account proxy options through to the fetch layer", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ answers: {} }));
    vi.stubGlobal("fetch", fetchMock);
    const proxy = { connectionProxyEnabled: true, connectionProxyUrl: "http://proxy.example:8080", strictProxy: true };
    await handleSystemoneCore({ body, modelInfo: { provider: "opencode", model: "jev-1.13-free" }, credentials: { providerSpecificData: proxy } });
    expect(fetchMock.mock.calls[0][2]).toEqual(proxy);
  });

  it("probes native answers instead of chat completions", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(Response.json({ answers: { probe: { noul: 0.9 } } })).mockResolvedValueOnce(Response.json({}));
    vi.stubGlobal("fetch", fetchMock);
    expect(await pingModelByKind(body.model, "systemone", "http://localhost:20128")).toMatchObject({ ok: true });
    expect(fetchMock.mock.calls[0][0]).toBe("http://localhost:20128/api/v1/systemone");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ model: body.model, questions: { probe: { type: "noul" } } });
    expect(await pingModelByKind(body.model, "systemone", "http://localhost:20128")).toMatchObject({ ok: false, error: "Provider returned no answers for this model" });
  });
});
