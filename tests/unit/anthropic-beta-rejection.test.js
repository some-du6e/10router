// Anthropic-compatible gateways that 400 on unknown anthropic-beta flags
// (Snowflake Cortex wording, captured 2026-10-19).
import { describe, it, expect, vi, beforeEach } from "vitest";

const fetchMock = vi.fn();
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: (...args) => fetchMock(...args),
}));

const { DefaultExecutor } = await import("../../open-sse/executors/default.js");
const { filterBetaHeaders, parseRejectedBetas } = await import("../../open-sse/utils/anthropicBeta.js");

const SNOWFLAKE_400 = "{\"message\":\"Unexpected value(s) `oauth-2025-04-20`, `redact-thinking-2026-02-12` for the `anthropic-beta` header. Please consult our documentation at platform.claude.com/docs or try again without the header.\"}";

function res(status, text = "") {
  return { status, ok: status >= 200 && status < 300, headers: { get: () => "" }, clone: () => ({ text: async () => text }) };
}

const creds = (psd = {}) => ({
  apiKey: "k",
  providerSpecificData: { baseUrl: "https://acme.snowflakecomputing.com/api/v2/cortex/v1", ...psd },
});
const sentBeta = (call) => call[1].headers["anthropic-beta"] ?? call[1].headers["Anthropic-Beta"];

// The executor has no static beta header for these nodes, so give it one as a
// client preset / custom header would.
function exec() {
  const ex = new DefaultExecutor("anthropic-compatible-test");
  ex.config = { ...ex.config, headers: { "anthropic-beta": "claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,redact-thinking-2026-02-12" } };
  return ex;
}

beforeEach(() => fetchMock.mockReset());

describe("parseRejectedBetas", () => {
  it("reads every backticked flag Snowflake names", () => {
    expect(parseRejectedBetas(SNOWFLAKE_400)).toEqual(["oauth-2025-04-20", "redact-thinking-2026-02-12"]);
  });
  it("ignores unrelated 400s", () => {
    expect(parseRejectedBetas("{\"message\":\"messages: at least one message is required\"}")).toEqual([]);
    expect(parseRejectedBetas("")).toEqual([]);
  });
});

describe("filterBetaHeaders", () => {
  it("always drops claude-code-20250219 and the remembered flags", () => {
    const h = filterBetaHeaders({ "anthropic-beta": "claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14" }, { dropped: ["oauth-2025-04-20"] });
    expect(h["anthropic-beta"]).toBe("interleaved-thinking-2025-05-14");
  });
  it("removes the header when nothing is left", () => {
    const h = filterBetaHeaders({ "Anthropic-Beta": "claude-code-20250219" });
    expect("Anthropic-Beta" in h).toBe(false);
  });
  it("stripAll removes every flag", () => {
    const h = filterBetaHeaders({ "anthropic-beta": "interleaved-thinking-2025-05-14" }, { stripAll: true });
    expect("anthropic-beta" in h).toBe(false);
  });
});

describe("DefaultExecutor — anthropic-compatible beta rejection", () => {
  it("drops the flags the 400 names, retries once, and reports them", async () => {
    fetchMock.mockResolvedValueOnce(res(400, SNOWFLAKE_400)).mockResolvedValueOnce(res(200));
    const onBetasRejected = vi.fn();
    const out = await exec().execute({ model: "claude-haiku-4-5", body: {}, stream: false, credentials: creds(), onBetasRejected });

    expect(out.response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sentBeta(fetchMock.mock.calls[0])).toBe("oauth-2025-04-20,interleaved-thinking-2025-05-14,redact-thinking-2026-02-12");
    expect(sentBeta(fetchMock.mock.calls[1])).toBe("interleaved-thinking-2025-05-14");
    expect(onBetasRejected).toHaveBeenCalledWith(["oauth-2025-04-20", "redact-thinking-2026-02-12"]);
    expect(out.droppedBetas).toEqual(["oauth-2025-04-20", "redact-thinking-2026-02-12"]);
  });

  it("skips the flags it already learned, so no failed first try", async () => {
    fetchMock.mockResolvedValueOnce(res(200));
    await exec().execute({ model: "m", body: {}, stream: false, credentials: creds({ droppedBetas: ["oauth-2025-04-20", "redact-thinking-2026-02-12"] }) });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sentBeta(fetchMock.mock.calls[0])).toBe("interleaved-thinking-2025-05-14");
  });

  it("stops once the 400 names nothing it still sends, but remembers what it learned", async () => {
    fetchMock.mockResolvedValue(res(400, SNOWFLAKE_400));
    const onBetasRejected = vi.fn();
    const out = await exec().execute({ model: "m", body: {}, stream: false, credentials: creds(), onBetasRejected });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(out.response.status).toBe(400);
    expect(onBetasRejected).toHaveBeenCalledWith(["oauth-2025-04-20", "redact-thinking-2026-02-12"]);
  });

  it("leaves other 400s alone", async () => {
    fetchMock.mockResolvedValueOnce(res(400, "{\"message\":\"unknown model \\\"x\\\"\"}"));
    const out = await exec().execute({ model: "x", body: {}, stream: false, credentials: creds() });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(out.response.status).toBe(400);
  });

  it("never drops a flag it didn't send", async () => {
    fetchMock.mockResolvedValueOnce(res(400, "{\"message\":\"Unexpected value(s) `made-up-2099-01-01` for the `anthropic-beta` header.\"}"));
    await exec().execute({ model: "m", body: {}, stream: false, credentials: creds() });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("stripBeta sends no beta header and never retries", async () => {
    fetchMock.mockResolvedValueOnce(res(200));
    await exec().execute({ model: "m", body: {}, stream: false, credentials: creds({ stripBeta: true }) });
    const h = fetchMock.mock.calls[0][1].headers;
    expect(h["anthropic-beta"] ?? h["Anthropic-Beta"]).toBeUndefined();
  });

  it("does nothing for non-compatible providers", async () => {
    fetchMock.mockResolvedValueOnce(res(400, SNOWFLAKE_400));
    const ex = new DefaultExecutor("openai");
    await ex.execute({ model: "m", body: {}, stream: false, credentials: { apiKey: "k" } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
