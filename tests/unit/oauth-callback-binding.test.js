import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  checkPastedState,
  handleRelayedCallback,
  isCallbackForPendingAuth,
  isOwnPopup,
  isTrustedCallbackOrigin,
  newPopupName,
  openLoginPopup,
  openLoginTab,
  parsePastedCallback,
  PROXY_OAUTH_PROVIDERS,
  STATELESS_CALLBACK_PROVIDERS,
} from "../../src/shared/utils/oauthCallbackBinding.js";

const PROXY = ["trae", "windsurf", "zed"];
const STATELESS = ["cline", "clinepass"];
const pending = { state: "s-123", redirectUri: "http://localhost:20128/callback" };
const ctx = (overrides = {}) => ({ provider: "gemini-cli", authData: pending, processed: false, via: "broadcast", ...overrides });
// A postMessage from the popup this dialog opened, sent by the /callback page at the redirect URI.
const fromPopup = (provider, overrides = {}) => ctx({ provider, via: "message", fromOwnPopup: true, origin: "http://localhost:20128", ...overrides });

function deps() {
  return { markProcessed: vi.fn(), notice: vi.fn(), fail: vi.fn(), exchange: vi.fn(async () => {}) };
}

describe("provider lists", () => {
  it("are exactly the proxy and stateless providers", () => {
    expect([...PROXY_OAUTH_PROVIDERS].sort()).toEqual(PROXY);
    expect([...STATELESS_CALLBACK_PROVIDERS].sort()).toEqual(STATELESS);
  });
});

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

  it.each(PROXY)("never takes a relayed callback for %s, with or without proxyProvider set", (provider) => {
    expect(isCallbackForPendingAuth({ code: "c", state: "s-123" }, ctx({ provider }))).toBe(false);
    expect(isCallbackForPendingAuth({ code: "c", state: "s-123" }, ctx({ provider, authData: { ...pending, proxyProvider: provider } }))).toBe(false);
    expect(isCallbackForPendingAuth({ token: "eyJ.attacker" }, fromPopup(provider))).toBe(false);
  });

  it("refuses a pending login that went through the local proxy, whatever the provider", () => {
    expect(isCallbackForPendingAuth({ code: "c", state: "s-123" }, ctx({ authData: { ...pending, proxyProvider: "other" } }))).toBe(false);
  });

  it.each(STATELESS)("takes a %s callback only from the dialog's popup, sent from the redirect URI's origin", (provider) => {
    expect(isCallbackForPendingAuth({ code: "c" }, fromPopup(provider))).toBe(true);
    expect(isCallbackForPendingAuth({ code: "c" }, fromPopup(provider, { fromOwnPopup: false }))).toBe(false);
    // Another loopback port is not the redirect URI.
    expect(isCallbackForPendingAuth({ code: "c" }, fromPopup(provider, { origin: "http://localhost:1455" }))).toBe(false);
    expect(isCallbackForPendingAuth({ code: "c" }, fromPopup(provider, { origin: undefined }))).toBe(false);
    expect(isCallbackForPendingAuth({ code: "c" }, fromPopup(provider, { authData: { state: "s-123" } }))).toBe(false);
    expect(isCallbackForPendingAuth({ code: "c" }, ctx({ provider, via: "broadcast" }))).toBe(false);
    expect(isCallbackForPendingAuth({ code: "c" }, ctx({ provider, via: "storage" }))).toBe(false);
  });

  it("refuses callbacks with no pending login or no provider", () => {
    expect(isCallbackForPendingAuth({ code: "c", state: "s-123" }, ctx({ authData: null }))).toBe(false);
    expect(isCallbackForPendingAuth({ code: "c", state: "s-123" }, ctx({ provider: null }))).toBe(false);
  });
});

describe("the dialog's own popup", () => {
  it("gets a fresh window name for every login, so window.open never reuses another page's window", () => {
    const names = new Set(Array.from({ length: 50 }, () => newPopupName()));
    expect(names.size).toBe(50);
    for (const name of names) expect(name).toMatch(/^oauth_popup_[0-9a-f]{24}$/);
  });

  it("opens each login's popup under a new name and keeps the window it got", () => {
    const opened = [];
    const popup = {};
    const open = vi.fn((url, target, features) => { opened.push({ url, target, features }); return popup; });
    expect(openLoginPopup(open, "https://auth.example.test/a")).toBe(popup);
    expect(openLoginPopup(open, "https://auth.example.test/b")).toBe(popup);
    expect(opened[0]).toEqual({ url: "https://auth.example.test/a", target: expect.stringMatching(/^oauth_popup_[0-9a-f]{24}$/), features: "width=600,height=700" });
    expect(opened[0].target).not.toBe(opened[1].target);
    // A blocked popup leaves nothing to track.
    expect(openLoginPopup(() => null, "https://auth.example.test/a")).toBeNull();
  });

  it("tracks no popup when the login opens in a new tab", () => {
    const open = vi.fn(() => ({}));
    expect(openLoginTab(open, "https://auth.example.test/a")).toBeNull();
    expect(open).toHaveBeenCalledWith("https://auth.example.test/a", "_blank");
  });

  it("is how the connect dialog opens every login window", () => {
    const modal = readFileSync(fileURLToPath(new URL("../../src/shared/components/OAuthModal.js", import.meta.url)), "utf8");
    expect(modal).not.toMatch(/["']oauth_popup["']/);
    expect(modal).not.toMatch(/window\.open\((?:data|authData)\.authUrl/);
    expect(modal).toMatch(/popupRef\.current = openLoginTab\(/);
  });

  it("counts a message as ours only when its source is the popup we opened", () => {
    const popup = {};
    expect(isOwnPopup(popup, popup)).toBe(true);
    expect(isOwnPopup({}, popup)).toBe(false);
    // No popup open (the non-localhost "_blank" path resets it): nothing is ours.
    expect(isOwnPopup(popup, null)).toBe(false);
    expect(isOwnPopup(null, null)).toBe(false);
    expect(isOwnPopup(undefined, undefined)).toBe(false);
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

  it("doesn't let a forged stateless callback or error reach a pending Cline login", async () => {
    const d = deps();
    expect(await handleRelayedCallback({ error: "access_denied" }, ctx({ provider: "cline", via: "broadcast" }), d)).toBe("ignored");
    expect(await handleRelayedCallback({ code: "forged" }, ctx({ provider: "cline", via: "storage" }), d)).toBe("ignored");
    expect(await handleRelayedCallback({ code: "forged" }, fromPopup("cline", { fromOwnPopup: false }), d)).toBe("ignored");
    expect(d.fail).not.toHaveBeenCalled();
    expect(d.exchange).not.toHaveBeenCalled();
    expect(await handleRelayedCallback({ code: "real" }, fromPopup("cline"), d)).toBe("exchanged");
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

describe("pasted callback", () => {
  it("refuses a pasted URL whose state names another login", () => {
    expect(checkPastedState("other", pending, "gemini-cli")).toMatch(/different sign-in/);
    expect(parsePastedCallback("http://localhost:20128/callback?code=attacker&state=other", pending, "gemini-cli"))
      .toEqual({ action: "error", message: expect.stringMatching(/different sign-in/) });
  });

  it("exchanges the code or token of a matching URL, or one with no state", () => {
    expect(parsePastedCallback(" http://localhost:20128/callback?code=c&state=s-123 ", pending, "gemini-cli"))
      .toEqual({ action: "exchange", code: "c", state: "s-123" });
    expect(parsePastedCallback("http://localhost:20128/callback?token=t&code=c", pending, "kimchi"))
      .toEqual({ action: "exchange", code: "t", state: null });
  });

  it("doesn't check the state of providers that were sent none", () => {
    expect(checkPastedState("anything", pending, "cline")).toBeNull();
    expect(checkPastedState("anything", { state: "" }, "gemini-cli")).toBeNull();
    expect(parsePastedCallback("http://localhost:20128/callback?code=c&state=x", pending, "cline").action).toBe("exchange");
  });

  it("takes a raw JWT, an xAI code or a bare Kimchi token as they are", () => {
    expect(parsePastedCallback("eyJhbGciOi.eyJzdWIi.sig", pending, "gemini-cli")).toEqual({ action: "exchange", code: "eyJhbGciOi.eyJzdWIi.sig", state: null });
    expect(parsePastedCallback("xai-code-123", pending, "xai")).toEqual({ action: "xai-code", code: "xai-code-123" });
    expect(parsePastedCallback("kimchi-token", pending, "kimchi")).toEqual({ action: "exchange", code: "kimchi-token", state: null });
  });

  it("explains a provider error, a missing code and something that isn't a URL", () => {
    expect(parsePastedCallback("http://localhost:20128/callback?error=access_denied&error_description=Denied&state=s-123", pending, "gemini-cli"))
      .toEqual({ action: "error", message: "Denied" });
    expect(parsePastedCallback("http://localhost:20128/callback?state=s-123", pending, "gemini-cli"))
      .toEqual({ action: "error", message: "No authorization code found in URL" });
    expect(parsePastedCallback("not a url", pending, "gemini-cli")).toEqual({ action: "error", message: expect.stringMatching(/full callback URL/) });
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
