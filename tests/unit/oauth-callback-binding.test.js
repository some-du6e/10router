import { describe, expect, it } from "vitest";
import { isCallbackForPendingAuth, isTrustedCallbackOrigin } from "../../src/shared/utils/oauthCallbackBinding.js";

const pending = {
  state: "s-123",
  authUrl: "https://auth.example.com/authorize?client_id=x&state=s-123&redirect_uri=http%3A%2F%2Flocalhost%3A20128%2Fcallback",
};

describe("OAuth callback relay binding", () => {
  it("accepts a callback that echoes the pending state", () => {
    expect(isCallbackForPendingAuth({ code: "c", state: "s-123" }, pending)).toBe(true);
  });

  it("rejects a callback carrying another login's state", () => {
    expect(isCallbackForPendingAuth({ code: "attacker", state: "other" }, pending)).toBe(false);
  });

  it("rejects a stateless callback when the provider was sent a state", () => {
    expect(isCallbackForPendingAuth({ token: "eyJ.attacker" }, pending)).toBe(false);
    expect(isCallbackForPendingAuth({ error: "access_denied" }, pending)).toBe(false);
  });

  it("accepts a stateless callback for a provider that is never sent a state", () => {
    const cline = { state: "s-123", authUrl: "https://app.cline.bot/auth?client_type=extension&callback_url=x" };
    expect(isCallbackForPendingAuth({ code: "c" }, cline)).toBe(true);
  });

  it("rejects callbacks with no pending login", () => {
    expect(isCallbackForPendingAuth({ code: "c", state: "s-123" }, null)).toBe(false);
  });
});

describe("OAuth postMessage origin allowlist", () => {
  const own = "http://192.168.1.5:20128";
  it.each([own, "http://localhost:20128", "http://127.0.0.1:1455", "http://[::1]:20128"])("trusts %s", (origin) => {
    expect(isTrustedCallbackOrigin(origin, own)).toBe(true);
  });

  it.each(["https://localhost.attacker.example", "http://127.0.0.1.attacker.example", "https://attacker.example/localhost", "null"])(
    "rejects %s",
    (origin) => {
      expect(isTrustedCallbackOrigin(origin, own)).toBe(false);
    },
  );
});
