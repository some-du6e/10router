import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

vi.mock("@/shared/utils/machineId", () => ({
  getConsistentMachineId: vi.fn(async (salt) => (salt === "9r-cli-auth" ? "0123456789abcdef" : "other")),
}));

describe("CLI token", () => {
  it("uses the salt and header the CLI package sends", async () => {
    const { CLI_TOKEN_HEADER, CLI_TOKEN_SALT } = await import("../../src/lib/auth/cliToken.js");
    const client = fs.readFileSync(path.join(ROOT, "cli/src/cli/api/client.js"), "utf8");
    expect(CLI_TOKEN_SALT).toBe("9r-cli-auth");
    expect(CLI_TOKEN_HEADER).toBe("x-9r-cli-token");
    expect(client).toContain(`CLI_TOKEN_SALT = "${CLI_TOKEN_SALT}"`);
    expect(client).toContain(`CLI_TOKEN_HEADER = "${CLI_TOKEN_HEADER}"`);
  });

  it("accepts only the exact token", async () => {
    const { isValidCliToken, getCliToken } = await import("../../src/lib/auth/cliToken.js");
    expect(await getCliToken()).toBe("0123456789abcdef");
    expect(await isValidCliToken("0123456789abcdef")).toBe(true);
    for (const wrong of [undefined, null, "", "anything", "0123456789abcdeX", "0123456789abcdef0"]) {
      expect(await isValidCliToken(wrong)).toBe(false);
    }
  });

  it("is derived in one place on the server", () => {
    const hits = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(js|ts|tsx|mjs)$/.test(entry.name) && fs.readFileSync(full, "utf8").includes("9r-cli-auth")) {
          hits.push(path.relative(ROOT, full));
        }
      }
    };
    walk(path.join(ROOT, "src"));
    walk(path.join(ROOT, "open-sse"));
    expect(hits.sort()).toEqual([path.join("src", "lib", "auth", "cliToken.ts"), path.join("src", "shared", "utils", "machineId.js")].sort());
  });
});

describe("shared redaction", () => {
  it("sanitizeSecrets removes raw, JSON-escaped and URL-encoded credential values, Copilot tokens included", async () => {
    const { sanitizeSecrets } = await import("../../open-sse/utils/redact.js");
    const creds = {
      apiKey: 'key/with"quote\\slash',
      providerSpecificData: { copilotToken: "copilot-token-placeholder-01" },
      copilotToken: "copilot-token-placeholder-02",
    };
    const text = [
      creds.apiKey,
      JSON.stringify({ k: creds.apiKey }),
      JSON.stringify(creds.apiKey).replace(/\//g, "\\/"),
      encodeURIComponent(creds.apiKey),
      creds.providerSpecificData.copilotToken,
      creds.copilotToken,
      "Authorization: Bearer some.bearer-token_value",
    ].join(" | ");
    const out = sanitizeSecrets(text, creds, "[REDACTED]");
    expect(out).not.toContain("with");
    expect(out).not.toContain("copilot-token-placeholder");
    expect(out).not.toContain("some.bearer-token_value");
    expect(out).toContain("[REDACTED]");
  });

  it("uses one header rule for logs, the Translator preview and stored request details", async () => {
    const { isSensitiveHeader, maskSensitiveHeaders, redactSensitiveHeaders, dropSensitiveHeaders } = await import(
      "../../open-sse/utils/redact.js"
    );
    const headers = {
      Authorization: "Bearer sk-placeholder-0000000000",
      "x-goog-api-key": "AIzaPlaceholder00000000",
      "x-9r-cli-token": "0123456789abcdef",
      Cookie: "auth_token=placeholder",
      "content-type": "application/json",
    };
    for (const name of ["Authorization", "x-goog-api-key", "x-9r-cli-token", "Cookie", "x-api-key", "proxy-authorization"]) {
      expect(isSensitiveHeader(name)).toBe(true);
    }
    expect(isSensitiveHeader("content-type")).toBe(false);
    // Usage counters only mention tokens: logs keep them readable.
    for (const name of [
      "x-ratelimit-remaining-tokens",
      "x-ratelimit-limit-tokens",
      "anthropic-ratelimit-input-tokens-limit",
      "anthropic-ratelimit-output-tokens-reset",
      "anthropic-ratelimit-tokens-remaining",
    ]) {
      expect(isSensitiveHeader(name)).toBe(false);
    }
    expect(maskSensitiveHeaders({ "x-ratelimit-remaining-tokens": "39999" })).toEqual({ "x-ratelimit-remaining-tokens": "39999" });
    for (const name of ["set-cookie", "x-amz-security-token", "x-csrf-token"]) expect(isSensitiveHeader(name)).toBe(true);
    expect(Object.keys(dropSensitiveHeaders(headers))).toEqual(["content-type"]);
    expect(redactSensitiveHeaders(headers)["x-goog-api-key"]).toBe("[REDACTED]");
    expect(JSON.stringify(maskSensitiveHeaders(headers))).not.toContain("AIzaPlaceholder");
  });

  it("uses one secret query-param list for URLs and for free text", async () => {
    const { redactUrlSecrets, SECRET_QUERY_PARAM_RE } = await import("../../open-sse/utils/redact.js");
    const params = ["key", "api_key", "api-key", "apikey", "access_token", "token", "auth", "sig", "signature", "code"];
    for (const name of params) {
      expect(redactUrlSecrets(`https://u.example/p?${name}=SECRET1&alt=sse`)).toBe(`https://u.example/p?${name}=[REDACTED]&alt=sse`);
      expect(`see https://u.example/p?${name.toUpperCase()}=SECRET2`.replace(SECRET_QUERY_PARAM_RE, "$1x")).not.toContain("SECRET2");
    }
    const { isSecretQueryParamName } = await import("../../open-sse/utils/redact.js");
    for (const name of ["exaApiKey", "tavilyApiKey", "refresh_token", "client_secret", "X-Amz-Signature"]) {
      expect(isSecretQueryParamName(name)).toBe(true);
      expect(redactUrlSecrets(`https://mcp.example/s?${name}=SECRET4&q=1`)).toBe(`https://mcp.example/s?${name}=[REDACTED]&q=1`);
    }
    expect(isSecretQueryParamName("alt")).toBe(false);
    const { makeRedactor } = await import("../../src/lib/endpointDetect.ts");
    expect(makeRedactor("")("Authorization: Bearer abcdefgh1234")).not.toContain("abcdefgh1234");
    expect(makeRedactor("")("https://u.example/p?signature=SECRET3")).not.toContain("SECRET3");
  });
});
