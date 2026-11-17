import { describe, expect, it, vi } from "vitest";
import {
  checkPastedState,
  handleRelayedCallback,
  isCallbackForPendingAuth,
  isTrustedCallbackOrigin,
  PROXY_OAUTH_PROVIDERS,
  STATELESS_CALLBACK_PROVIDERS,
} from "../../src/shared/utils/oauthCallbackBinding.js";

const pending = { state: "s-123" };
const ctx = (overrides = {}) => ({ provider: "gemini-cli", authData: pending, processed: false, via: "broadcast", ...overrides });

function deps() {
  return { markProcessed: vi.fn(), notice: vi.fn(), fail: vi.fn(), exchange: vi.fn(async () => {}) };
}

describe("which relayed callbacks belong to the pending login", () => {
  it("accepts a callback that echoes the pending state", () => {
    expect(isCallbackForPendingAuth({ code: "c", state: "s-123" }, ctx())).toBe(true);
  });

  it("rejects a callback carrying another login's state, or none", () => {
    expect(isCallbackForPendingAuth({ code: "attacker", state: "other" }, ctx())).toBe(false);
    expect(isCallbackForPendingAuth({ token: "eyJ.attacker" }, ctx({ provider: "kimchi" }))).toBe(false);
  });

  it("requires state for every provider outside the stateless list", () => {
    expect(isCallbackForPendingAuth({ code: "c" }, ctx({ provider: "gitlab" }))).toBe(false);
    expect(isCallbackForPendingAuth({ code: "c", state: "" }, ctx({ authData: { state: "" } }))).toBe(false);
  });

  it("never takes a relayed callback for a proxy provider, with or without proxyProvider set", () => {
    for (const provider of PROXY_OAUTH_PROVIDERS) {
      expect(isCallbackForPendingAuth({ code: "c", state: "s-123" }, ctx({ provider })), provider).toBe(false);
      expect(isCallbackForPendingAuth({ code: "c", state: "s-123" }, ctx({ provider, authData: { ...pending, proxyProvider: provider } })), provider).toBe(false);
    }
    // Trae carries its state as login_trace_id, so its relays never echo state=.
    expect(isCallbackForPendingAuth({ token: "eyJ.attacker" }, ctx({ provider: "trae", via: "message", fromOwnPopup: true }))).toBe(false);
  });

  it("refuses a pending login that went through the local proxy, whatever the provider", () => {
    expect(isCallbackForPendingAuth({ code: "c", state: "s-123" }, ctx({ authData: { ...pending, proxyProvider: "other" } }))).toBe(false);
  });

  it("takes a stateless provider's callback only from the popup this dialog opened", () => {
    for (const provider of STATELESS_CALLBACK_PROVIDERS) {
      expect(isCallbackForPendingAuth({ code: "c" }, ctx({ provider, via: "message", fromOwnPopup: true })), provider).toBe(true);
      expect(isCallbackForPendingAuth({ code: "c" }, ctx({ provider, via: "message", fromOwnPopup: false })), provider).toBe(false);
      expect(isCallbackForPendingAuth({ code: "c" }, ctx({ provider, via: "broadcast" })), provider).toBe(false);
      expect(isCallbackForPendingAuth({ code: "c" }, ctx({ provider, via: "storage" })), provider).toBe(false);
    }
  });

  it("refuses callbacks with no pending login or no provider", () => {
    expect(isCallbackForPendingAuth({ code: "c", state: "s-123" }, ctx({ authData: null }))).toBe(false);
    expect(isCallbackForPendingAuth({ code: "c", state: "s-123" }, ctx({ provider: null }))).toBe(false);
  });
});

describe("handleRelayedCallback", () => {
  it("ignores a mismatched callback without consuming the login or touching the paste field", async () => {
    const d = deps();
    expect(await handleRelayedCallback({ code: "attacker", state: "junk", fullUrl: "http://localhost:20128/callback?code=attacker" }, ctx(), d)).toBe("ignored");
    expect(d.markProcessed).not.toHaveBeenCalled();
    expect(d.notice).toHaveBeenCalledOnce();
    expect(d.exchange).not.toHaveBeenCalled();
    expect(d.fail).not.toHaveBeenCalled();
  });

  it("still takes the real callback after a mismatched one", async () => {
    let processed = false;
    const d = { ...deps(), markProcessed: vi.fn(() => { processed = true; }) };
    await handleRelayedCallback({ code: "attacker", state: "junk" }, ctx({ processed }), d);
    expect(processed).toBe(false);
    expect(await handleRelayedCallback({ code: "real", state: "s-123" }, ctx({ processed }), d)).toBe("exchanged");
    expect(d.exchange).toHaveBeenCalledWith("real", "s-123");
    expect(await handleRelayedCallback({ code: "again", state: "s-123" }, ctx({ processed }), d)).toBe("ignored");
    expect(d.exchange).toHaveBeenCalledOnce();
  });

  it("marks the login processed before exchanging, so a second relay can't race in", async () => {
    const order = [];
    const d = { ...deps(), markProcessed: vi.fn(() => order.push("mark")), exchange: vi.fn(async () => { order.push("exchange"); }) };
    await handleRelayedCallback({ token: "t", code: "c", state: "s-123" }, ctx(), d);
    expect(order).toEqual(["mark", "exchange"]);
    expect(d.exchange).toHaveBeenCalledWith("t", "s-123");
  });

  it("reports an error the provider sent for this login", async () => {
    const d = deps();
    expect(await handleRelayedCallback({ error: "access_denied", errorDescription: "Denied", state: "s-123" }, ctx(), d)).toBe("failed");
    expect(d.markProcessed).toHaveBeenCalledOnce();
    expect(d.fail).toHaveBeenCalledWith("Denied");
  });

  it("keeps the login pending on an error that carries no state", async () => {
    const d = deps();
    expect(await handleRelayedCallback({ error: "access_denied" }, ctx(), d)).toBe("ignored");
    expect(d.fail).not.toHaveBeenCalled();
    expect(d.markProcessed).not.toHaveBeenCalled();
    expect(d.notice).toHaveBeenCalledOnce();
  });

  it("doesn't let a forged stateless error kill a pending Cline login", async () => {
    const d = deps();
    expect(await handleRelayedCallback({ error: "access_denied" }, ctx({ provider: "cline", via: "broadcast" }), d)).toBe("ignored");
    expect(await handleRelayedCallback({ code: "forged" }, ctx({ provider: "cline", via: "storage" }), d)).toBe("ignored");
    expect(d.fail).not.toHaveBeenCalled();
    expect(d.exchange).not.toHaveBeenCalled();
    expect(await handleRelayedCallback({ code: "real" }, ctx({ provider: "cline", via: "message", fromOwnPopup: true }), d)).toBe("exchanged");
  });

  it("ignores everything once the login took a callback, and anything without a provider", async () => {
    const d = deps();
    expect(await handleRelayedCallback({ code: "c", state: "s-123" }, ctx({ processed: true }), d)).toBe("ignored");
    expect(await handleRelayedCallback({ code: "c", state: "s-123" }, ctx({ provider: undefined }), d)).toBe("ignored");
    expect(d.markProcessed).not.toHaveBeenCalled();
    expect(d.exchange).not.toHaveBeenCalled();
  });

  it("ignores a matching callback with nothing in it, quietly", async () => {
    const d = deps();
    expect(await handleRelayedCallback({ state: "s-123" }, ctx(), d)).toBe("ignored");
    expect(d.notice).not.toHaveBeenCalled();
    expect(d.markProcessed).not.toHaveBeenCalled();
  });
});

describe("pasted callback URL state", () => {
  it("refuses a pasted URL whose state names another login", () => {
    expect(checkPastedState("other", pending, "gemini-cli")).toMatch(/different sign-in/);
  });

  it("accepts the matching state, or a URL with no state", () => {
    expect(checkPastedState("s-123", pending, "gemini-cli")).toBeNull();
    expect(checkPastedState(null, pending, "kimchi")).toBeNull();
  });

  it("doesn't check providers that were sent no state", () => {
    expect(checkPastedState("anything", pending, "cline")).toBeNull();
    expect(checkPastedState("anything", { state: "" }, "gemini-cli")).toBeNull();
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
