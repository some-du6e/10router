import { describe, expect, it } from "vitest";
import {
  decideRelayedCallback,
  isCallbackForPendingAuth,
  isTrustedCallbackOrigin,
} from "../../src/shared/utils/oauthCallbackBinding.js";

const pending = {
  state: "s-123",
  authUrl: "https://auth.example.com/authorize?client_id=x&state=s-123&redirect_uri=http%3A%2F%2Flocalhost%3A20128%2Fcallback",
};

describe("OAuth callback relay binding", () => {
  it("accepts a callback that echoes the pending state", () => {
    expect(isCallbackForPendingAuth({ code: "c", state: "s-123" }, pending, "gemini-cli")).toBe(true);
  });

  it("rejects a callback carrying another login's state", () => {
    expect(isCallbackForPendingAuth({ code: "attacker", state: "other" }, pending, "gemini-cli")).toBe(false);
  });

  it("rejects a stateless callback for a provider that was given a state", () => {
    expect(isCallbackForPendingAuth({ token: "eyJ.attacker" }, pending, "kimchi")).toBe(false);
    expect(isCallbackForPendingAuth({ error: "access_denied" }, pending, "gemini-cli")).toBe(false);
  });

  it("requires state even when the authorize URL carries it under another name", () => {
    // Trae sends its state as login_trace_id, not state=.
    const custom = { state: "s-123", authUrl: "https://auth.example.com/login?login_trace_id=s-123" };
    expect(isCallbackForPendingAuth({ code: "c" }, custom, "gitlab")).toBe(false);
  });

  it("never takes a relayed callback for a provider its local proxy exchanges", () => {
    for (const provider of ["trae", "windsurf", "zed"]) {
      const authData = { state: "s-123", authUrl: "https://auth.example.com/login?login_trace_id=s-123", proxyProvider: provider };
      expect(isCallbackForPendingAuth({ token: "eyJ.attacker" }, authData, provider), provider).toBe(false);
      expect(isCallbackForPendingAuth({ code: "c", state: "s-123" }, authData, provider), provider).toBe(false);
    }
  });

  it("accepts a stateless callback only for the providers that are never sent a state", () => {
    const cline = { state: "s-123", authUrl: "https://app.cline.example/auth?client_type=extension&callback_url=x" };
    expect(isCallbackForPendingAuth({ code: "c" }, cline, "cline")).toBe(true);
    expect(isCallbackForPendingAuth({ code: "c" }, cline, "clinepass")).toBe(true);
    expect(isCallbackForPendingAuth({ code: "c", state: "other" }, cline, "cline")).toBe(false);
    expect(isCallbackForPendingAuth({ code: "c" }, cline, "kimchi")).toBe(false);
  });

  it("rejects callbacks with no pending login or no state on it", () => {
    expect(isCallbackForPendingAuth({ code: "c", state: "s-123" }, null, "gemini-cli")).toBe(false);
    expect(isCallbackForPendingAuth({ code: "c", state: "" }, { state: "" }, "gemini-cli")).toBe(false);
    expect(isCallbackForPendingAuth({ code: "c", state: "s-123" }, pending, null)).toBe(false);
  });
});

describe("what the connect dialog does with a relayed callback", () => {
  it("ignores a mismatched callback and still takes the real one after it", () => {
    // The dialog only marks the login handled for a non-ignore decision.
    let handled = false;
    const run = (data) => {
      if (handled) return null;
      const decision = decideRelayedCallback(data, pending, "gemini-cli");
      if (decision.action !== "ignore") handled = true;
      return decision;
    };

    expect(run({ code: "attacker", state: "junk", fullUrl: "http://localhost:20128/callback?code=attacker&state=junk" }))
      .toEqual({ action: "ignore", notice: true });
    expect(handled).toBe(false);
    expect(run({ code: "real", state: "s-123" })).toEqual({ action: "exchange", code: "real", state: "s-123" });
  });

  it("doesn't hand the mismatched callback's URL to the paste step", () => {
    const decision = decideRelayedCallback({ code: "attacker", state: "junk", fullUrl: "http://x/callback?code=attacker" }, pending, "gemini-cli");
    expect(decision).toEqual({ action: "ignore", notice: true });
    expect(JSON.stringify(decision)).not.toContain("attacker");
  });

  it("reports an error the provider sent for this login", () => {
    expect(decideRelayedCallback({ error: "access_denied", errorDescription: "Denied", state: "s-123" }, pending, "gemini-cli"))
      .toEqual({ action: "error", message: "Denied" });
  });

  it("prefers a token over a code and ignores an empty callback quietly", () => {
    expect(decideRelayedCallback({ token: "t", code: "c", state: "s-123" }, pending, "gemini-cli"))
      .toEqual({ action: "exchange", code: "t", state: "s-123" });
    expect(decideRelayedCallback({ state: "s-123" }, pending, "gemini-cli")).toEqual({ action: "ignore", notice: false });
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
