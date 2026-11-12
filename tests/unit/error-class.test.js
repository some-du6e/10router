import { describe, expect, it } from "vitest";
import { classifyError, classifyThrownError, errorText, isBackoffText } from "../../open-sse/utils/errorClass.js";
import { formatProviderError } from "../../open-sse/utils/error.js";

const json = (o) => JSON.stringify(o);

describe("classifyError", () => {
  it.each([
    [401, "invalid token", "auth_error"],
    [403, "forbidden", "auth_error"],
    [429, "slow down", "rate_limited"],
    [403, "You exceeded your current quota", "rate_limited"],
    [400, '{"type":"rate_limit_error"}', "rate_limited"],
    [500, "boom", "upstream_5xx"],
    [503, "service_unavailable", "upstream_5xx"],
    [504, "", "timeout"],
    [502, "fetch connect timeout", "timeout"],
    [400, "bad request", "client_error"],
    [404, "model not found", "client_error"],
    [499, "Request aborted", "aborted"],
    [400, "Model not installed. Install via the CLI", "client_error"],
    [400, "invalid value for timeout parameter", "client_error"],
    [408, "", "timeout"],
    [502, "stream stalled", "timeout"],
    [503, "The model is overloaded", "rate_limited"],
    [403, "Too many requests", "rate_limited"],
    [undefined, "", "other"],
  ])("status %s / %s → %s", (status, message, expected) => {
    expect(classifyError(status, message)).toBe(expected);
  });

  it.each([
    ["402 payment required", 402, "Payment required", "rate_limited"],
    ["403 credits exhausted", 403, json({ error: { message: "Your credits are exhausted. Please top up." } }), "rate_limited"],
    ["403 billing", 403, json({ error: { message: "Billing account is overdue" } }), "rate_limited"],
    ["403 key limit", 403, json({ error: { message: "Key limit exceeded (daily limit)" } }), "rate_limited"],
    ["403 model access", 403, json({ error: { message: "Project does not have access to model 'o3'", code: "model_not_found" } }), "client_error"],
    ["404 model access", 404, json({ error: { message: "The model `gpt-9` does not exist or you do not have access to it.", code: "model_not_found" } }), "client_error"],
    ["403 restricted key", 403, json({ error: { message: "You have insufficient permissions for this operation. Missing scopes: model.request." } }), "auth_error"],
    ["400 bad key", 400, json({ error: { code: 400, message: "API key not valid. Please pass a valid API key.", status: "INVALID_ARGUMENT", details: [{ reason: "API_KEY_INVALID" }] } }), "auth_error"],
    ["400 credit balance", 400, json({ type: "error", error: { type: "invalid_request_error", message: "Your credit balance is too low to access the Anthropic API." } }), "rate_limited"],
    ["400 context capacity", 400, json({ error: { message: "prompt exceeds context capacity" } }), "client_error"],
    ["Snowflake 403 003001", 403, json({ code: "003001", message: "Not authorized for this endpoint." }), "auth_error"],
    ["Codex 401 token_expired", 401, json({ error: { message: "Provided authentication token is expired. Please try signing in again.", type: "invalid_request_error", code: "token_expired" } }), "auth_error"],
    ["Codex 401 refresh reused", 401, json({ error: { message: "Your refresh token has already been used to generate a new access token. Please try signing in again.", code: "refresh_token_reused" } }), "auth_error"],
    ["Codex 429 usage limit", 429, json({ error: { type: "usage_limit_reached", message: "The usage limit has been reached", resets_in_seconds: 3600 } }), "rate_limited"],
    ["499 mentioning a limit", 499, "Request aborted while waiting for the rate limit", "aborted"],
    ["499 from AbortSignal.timeout", 499, "The operation was aborted due to timeout", "timeout"],
    ["500 with bad-key text", 500, "invalid api key for backend", "upstream_5xx"],
    ["503 with missing scopes", 503, "Missing scopes: model.request", "upstream_5xx"],
    ["400 missing scopes", 400, "Missing scopes: model.request", "auth_error"],
    ["404 insufficient permissions", 404, "You have insufficient permissions for this operation.", "auth_error"],
    ["401 too many requests", 401, "Too many requests", "rate_limited"],
    ["401 connect timeout", 401, "connect timeout", "auth_error"],
  ])("%s", (_name, status, message, expected) => {
    expect(classifyError(status, message)).toBe(expected);
  });

  it("only reads the first 8 KB of the message", () => {
    expect(classifyError(400, "x".repeat(20000) + "rate limit")).toBe("client_error");
    expect(classifyError(400, "x".repeat(4 * 1024) + "api key not valid")).toBe("auth_error");
    expect(classifyError(400, "x".repeat(9 * 1024) + "api key not valid")).toBe("client_error");
  });

  it.each([
    ["a Symbol", Symbol("s")],
    ["an object whose valueOf throws", { valueOf() { throw new Error("boom"); }, toString() { throw new Error("boom"); } }],
    ["NaN", NaN],
    ["null", null],
  ])("never throws on %s as the status", (_name, status) => {
    expect(classifyError(status, "boom")).toBe("other");
  });

  it("parses a string status", () => {
    expect(classifyError("429", "")).toBe("rate_limited");
  });

  it("treats a non-string message as empty", () => {
    expect(classifyError(500, { message: "rate limit" })).toBe("upstream_5xx");
    expect(classifyError(500, Symbol("x"))).toBe("upstream_5xx");
  });
});

describe("classifyThrownError", () => {
  const withCause = (message, code, causeMessage = "") =>
    new TypeError(message, { cause: Object.assign(new Error(causeMessage), { code }) });

  it.each([
    ["undici connect timeout cause", withCause("fetch failed", "UND_ERR_CONNECT_TIMEOUT", "Connect Timeout Error"), "timeout"],
    ["trae stream timeout", new Error("trae stream timeout"), "timeout"],
    ["AbortSignal.timeout", new DOMException("The operation was aborted due to timeout", "TimeoutError"), "timeout"],
    ["AbortError", Object.assign(new Error("This operation was aborted"), { name: "AbortError" }), "aborted"],
    ["ECONNREFUSED", withCause("fetch failed", "ECONNREFUSED", "connect ECONNREFUSED 127.0.0.1:1"), "network_error"],
    ["ENOTFOUND", withCause("fetch failed", "ENOTFOUND", "getaddrinfo ENOTFOUND api.example.test"), "network_error"],
    ["ECONNRESET", Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }), "network_error"],
    ["socket hang up", new Error("socket hang up"), "network_error"],
    ["bare fetch failed", new TypeError("fetch failed"), "network_error"],
    ["local bug", new TypeError("Cannot read properties of undefined (reading 'x')"), "other"],
  ])("%s", (_name, error, expected) => {
    expect(classifyThrownError(error)).toBe(expected);
  });

  it("classifies a TimeoutError as timeout whatever its text says", () => {
    expect(classifyThrownError(Object.assign(new Error("something odd"), { name: "TimeoutError" }))).toBe("timeout");
  });

  it("classifies an AbortError whose text says due to timeout as timeout", () => {
    expect(classifyThrownError(Object.assign(new Error("The operation was aborted due to timeout"), { name: "AbortError" }))).toBe("timeout");
  });

  it("reads the cause chain three levels deep", () => {
    const deep = new Error("fetch failed", {
      cause: new Error("level 1", { cause: new Error("level 2", { cause: Object.assign(new Error("level 3"), { code: "ECONNREFUSED" }) }) }),
    });
    expect(classifyThrownError(deep)).toBe("network_error");
    const tooDeep = new Error("a", { cause: new Error("b", { cause: new Error("c", { cause: new Error("d", { cause: new Error("socket hang up") }) }) }) });
    expect(classifyThrownError(tooDeep)).toBe("other");
  });

  it("finds a TimeoutError in the cause chain", () => {
    expect(classifyThrownError(new Error("wrapped", { cause: Object.assign(new Error("x"), { name: "TimeoutError" }) }))).toBe("timeout");
  });

  it("stops at a cause cycle", () => {
    const a = new Error("a");
    const b = new Error("b", { cause: a });
    a.cause = b;
    expect(classifyThrownError(a)).toBe("other");
    const self = new Error("self");
    self.cause = self;
    expect(classifyThrownError(self)).toBe("other");
  });

  it("keeps the cause code of a 10 MB message", () => {
    const cause = Object.assign(new Error("Connect Timeout Error"), { code: "UND_ERR_CONNECT_TIMEOUT" });
    expect(classifyThrownError(new Error("x".repeat(10 * 1024 * 1024), { cause }))).toBe("timeout");
  });

  it("never throws", () => {
    const hostile = { get message() { throw new Error("boom"); }, get name() { throw new Error("boom"); } };
    expect(classifyThrownError(hostile)).toBe("other");
    expect(classifyThrownError({ message: Symbol("x") })).toBe("other");
    expect(classifyThrownError(null)).toBe("other");
    expect(classifyThrownError("string error")).toBe("other");
  });
});

describe("errorText", () => {
  it("includes the fetch cause", () => {
    const err = new TypeError("fetch failed", { cause: Object.assign(new Error("Connect Timeout Error"), { code: "UND_ERR_CONNECT_TIMEOUT" }) });
    expect(errorText(err)).toBe("fetch failed UND_ERR_CONNECT_TIMEOUT Connect Timeout Error");
  });

  it("skips a non-string message, stringifies cause parts and never throws", () => {
    expect(errorText({ message: Symbol("x") })).toBe("");
    expect(errorText({ message: "m", cause: { code: Symbol("c"), message: 42 } })).toBe("m Symbol(c) 42");
    expect(errorText({ get message() { throw new Error("boom"); } })).toBe("");
  });
});

describe("isBackoffText", () => {
  it("matches the ERROR_RULES backoff texts, case-insensitively", () => {
    expect(isBackoffText("Model is OVERLOADED")).toBe(true);
    expect(isBackoffText("no credentials")).toBe(false);
    expect(isBackoffText(undefined)).toBe(false);
  });
});

describe("formatProviderError", () => {
  it("formats causes the way master did", () => {
    expect(formatProviderError({ message: "m", cause: { code: 0, message: "x" } }, "p", "m", 502)).toBe("[502]: m (cause: x)");
    expect(formatProviderError({ message: "m", cause: { code: "ECONNRESET", message: "read" } }, "p", "m", 502)).toBe("[502]: m (cause: ECONNRESET: read)");
    expect(formatProviderError({ message: "m", cause: { code: true, message: { a: 1 } } }, "p", "m", 502)).toBe("[502]: m (cause: true: [object Object])");
    expect(formatProviderError({ message: "m", cause: { code: NaN } }, "p", "m", 502)).toBe("[502]: m");
    expect(formatProviderError({ message: "m" }, "p", "m", 502)).toBe("[502]: m");
  });

  it("does not throw on a Symbol message", () => {
    expect(formatProviderError({ message: Symbol("s") }, "p", "m", 502)).toBe("[502]: Symbol(s)");
  });
});
