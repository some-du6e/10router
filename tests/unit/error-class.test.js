import { describe, expect, it } from "vitest";
import { classifyError, classifyThrownError, errorText, isBackoffText } from "../../open-sse/utils/errorClass.js";

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
  ])("%s", (_name, status, message, expected) => {
    expect(classifyError(status, message)).toBe(expected);
  });

  it("only reads the start of a huge message", () => {
    expect(classifyError(400, "x".repeat(20000) + "rate limit")).toBe("client_error");
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

  it("keeps only string parts and never throws", () => {
    expect(errorText({ message: Symbol("x") })).toBe("");
    expect(errorText({ message: "m", cause: { code: { nested: 1 }, message: 42 } })).toBe("m 42");
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
