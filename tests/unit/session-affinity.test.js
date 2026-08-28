import { describe, it, expect, beforeEach } from "vitest";
import {
  isAffinityProvider,
  affinityKeyFor,
  getAffinity,
  bindAffinity,
  releaseAffinity,
  clearAffinityStore,
} from "open-sse/services/sessionAffinity.js";

const codexHeaders = { session_id: "sess-abc" };

describe("session affinity — scoping", () => {
  beforeEach(() => clearAffinityStore());

  it("only recognises Codex as an affinity provider", () => {
    expect(isAffinityProvider("codex")).toBe(true);
    for (const other of ["claude", "gemini", "antigravity", "openai", "github", "xai"]) {
      expect(isAffinityProvider(other)).toBe(false);
    }
  });

  it("returns no key for non-Codex providers even with a session header", () => {
    for (const other of ["claude", "gemini", "antigravity"]) {
      expect(affinityKeyFor({ provider: other, headers: codexHeaders, body: {} })).toBeNull();
    }
  });

  it("returns no key when the client sent nothing identifying", () => {
    expect(affinityKeyFor({ provider: "codex", headers: {}, body: {} })).toBeNull();
    expect(affinityKeyFor({ provider: "codex" })).toBeNull();
  });
});

describe("session affinity — key derivation", () => {
  beforeEach(() => clearAffinityStore());

  it("derives a stable key from the session header", () => {
    const a = affinityKeyFor({ provider: "codex", headers: codexHeaders, body: {} });
    const b = affinityKeyFor({ provider: "codex", headers: { session_id: "sess-abc" }, body: {} });
    expect(a).toBe(b);
    expect(a).toContain("sess-abc");
  });

  it("accepts the newer x-codex-* session headers", () => {
    expect(affinityKeyFor({ provider: "codex", headers: { "x-codex-session-id": "s1" }, body: {} }))
      .toContain("s1");
    expect(affinityKeyFor({ provider: "codex", headers: { "x-codex-conversation-id": "c1" }, body: {} }))
      .toContain("c1");
  });

  it("accepts a Headers instance as well as a plain object", () => {
    const plain = affinityKeyFor({ provider: "codex", headers: codexHeaders, body: {} });
    const viaHeaders = affinityKeyFor({
      provider: "codex",
      headers: new Headers({ session_id: "sess-abc" }),
      body: {},
    });
    expect(viaHeaders).toBe(plain);
  });

  it("separates threads of the same process session", () => {
    const one = affinityKeyFor({ provider: "codex", headers: { ...codexHeaders, "thread-id": "t1" }, body: {} });
    const two = affinityKeyFor({ provider: "codex", headers: { ...codexHeaders, "thread-id": "t2" }, body: {} });
    const bare = affinityKeyFor({ provider: "codex", headers: codexHeaders, body: {} });
    expect(one).not.toBe(two);
    expect(one).not.toBe(bare);
  });

  it("distinguishes different sessions", () => {
    const a = affinityKeyFor({ provider: "codex", headers: { session_id: "a" }, body: {} });
    const b = affinityKeyFor({ provider: "codex", headers: { session_id: "b" }, body: {} });
    expect(a).not.toBe(b);
  });
});

describe("session affinity — binding lifecycle", () => {
  beforeEach(() => clearAffinityStore());

  it("has no pin before one is bound", () => {
    expect(getAffinity("codex:sess")).toBeNull();
    expect(getAffinity(null)).toBeNull();
  });

  it("returns the bound connection on later turns", () => {
    bindAffinity("codex:sess", "conn-1");
    expect(getAffinity("codex:sess")).toBe("conn-1");
    expect(getAffinity("codex:sess")).toBe("conn-1");
  });

  it("rebinds an existing session to a new connection", () => {
    bindAffinity("codex:sess", "conn-1");
    bindAffinity("codex:sess", "conn-2");
    expect(getAffinity("codex:sess")).toBe("conn-2");
  });

  it("ignores a bind with no key or no connection", () => {
    bindAffinity(null, "conn-1");
    bindAffinity("codex:sess", null);
    expect(getAffinity("codex:sess")).toBeNull();
  });

  it("drops the pin when the pinned account falls away", () => {
    bindAffinity("codex:sess", "conn-1");
    releaseAffinity("codex:sess", "conn-1");
    expect(getAffinity("codex:sess")).toBeNull();
  });

  it("does not undo a rebind performed by a concurrent turn", () => {
    // Turn A pins conn-1. Turn B fails over and rebinds to conn-2. Turn A's
    // late failure must not tear down the healthy pin B just established.
    bindAffinity("codex:sess", "conn-1");
    bindAffinity("codex:sess", "conn-2");
    releaseAffinity("codex:sess", "conn-1");
    expect(getAffinity("codex:sess")).toBe("conn-2");
  });

  it("releasing an unknown key is a no-op", () => {
    expect(() => releaseAffinity("codex:nope", "conn-1")).not.toThrow();
    expect(() => releaseAffinity(null, "conn-1")).not.toThrow();
  });
});
