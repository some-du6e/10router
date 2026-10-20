import { describe, expect, it } from "vitest";
import { classifyError, errorText } from "../../open-sse/utils/errorClass.js";

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
});

describe("errorText", () => {
  it("includes the fetch cause so undici timeouts classify as timeout", () => {
    const err = new TypeError("fetch failed", { cause: Object.assign(new Error("Connect Timeout Error"), { code: "UND_ERR_CONNECT_TIMEOUT" }) });
    expect(classifyError(502, errorText(err))).toBe("timeout");
    expect(classifyError(502, err.message)).toBe("upstream_5xx");
  });
});
