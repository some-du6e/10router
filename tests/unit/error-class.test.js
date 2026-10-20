import { describe, expect, it } from "vitest";
import { classifyError } from "../../open-sse/utils/errorClass.js";

describe("classifyError", () => {
  it.each([
    [401, "invalid token", "auth_locked"],
    [403, "forbidden", "auth_locked"],
    [429, "slow down", "rate_limited"],
    [403, "You exceeded your current quota", "rate_limited"],
    [400, '{"type":"rate_limit_error"}', "rate_limited"],
    [500, "boom", "upstream_5xx"],
    [503, "service_unavailable", "upstream_5xx"],
    [504, "", "timeout"],
    [502, "fetch connect timeout", "timeout"],
    [400, "bad request", "client_error"],
    [404, "model not found", "client_error"],
    [499, "Request aborted", "client_error"],
    [undefined, "", "other"],
  ])("status %s / %s → %s", (status, message, expected) => {
    expect(classifyError(status, message)).toBe(expected);
  });
});
