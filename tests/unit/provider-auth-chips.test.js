import { describe, it, expect } from "vitest";
import { OAUTH_PROVIDERS, APIKEY_PROVIDERS } from "@/shared/constants/config";
import { FREE_PROVIDERS, FREE_TIER_PROVIDERS } from "@/shared/constants/providers";

// Mirror of page.js dualAuthTypes + authGroupOf + authGroupsOf.
const dualAuthTypes = (info, key) => {
  if (key === "kiro") return ["oauth", "apikey", "api_key"];
  const modes = info?.authModes;
  if (!Array.isArray(modes)) {
    return key in FREE_TIER_PROVIDERS || key in APIKEY_PROVIDERS
      ? ["oauth", "apikey", "api_key"] : "oauth";
  }
  if (!modes.includes("apikey")) return "oauth";
  return ["oauth", "apikey", "api_key"];
};
const authGroupOf = (key, info) => {
  if (info.noAuth) return "free";
  if (key in FREE_PROVIDERS || key in FREE_TIER_PROVIDERS) return "free";
  if (key in OAUTH_PROVIDERS) return "oauth";
  return "apikey";
};
const authGroupsOf = (key, info) => {
  const primary = authGroupOf(key, info);
  const groups = new Set([primary]);
  if (primary !== "free" && dualAuthTypes(info, key) !== "oauth") {
    groups.add("apikey");
    if (key in OAUTH_PROVIDERS) groups.add("oauth");
  }
  return groups;
};

const all = { ...FREE_PROVIDERS, ...FREE_TIER_PROVIDERS, ...OAUTH_PROVIDERS, ...APIKEY_PROVIDERS };

describe("vendor-view auth chip filtering", () => {
  it("dual-auth oauth endpoints answer to BOTH chips", () => {
    const dual = Object.entries(all).filter(
      ([k, i]) => k in OAUTH_PROVIDERS && !i.noAuth && Array.isArray(i.authModes) && i.authModes.includes("apikey"),
    );
    expect(dual.length).toBeGreaterThan(0);
    for (const [k, i] of dual) {
      const g = authGroupsOf(k, i);
      expect(g.has("oauth"), `${k} lost its oauth chip`).toBe(true);
      expect(g.has("apikey"), `${k} hidden behind the API Key chip`).toBe(true);
    }
  });

  it("oauth-only endpoints do NOT leak into the API Key chip", () => {
    const oauthOnly = Object.entries(all).filter(
      ([k, i]) => k in OAUTH_PROVIDERS && !i.noAuth && k !== "kiro" &&
        Array.isArray(i.authModes) && !i.authModes.includes("apikey"),
    );
    expect(oauthOnly.length).toBeGreaterThan(0);
    for (const [k, i] of oauthOnly) {
      expect(authGroupsOf(k, i).has("apikey"), `${k} wrongly shown under API Key`).toBe(false);
    }
  });

  it("every provider still matches its own primary chip (nothing vanishes)", () => {
    for (const [k, i] of Object.entries(all)) {
      expect(authGroupsOf(k, i).has(authGroupOf(k, i)), `${k} vanished from all chips`).toBe(true);
    }
  });

  it("free providers stay free-only", () => {
    for (const [k, i] of Object.entries(all)) {
      if (authGroupOf(k, i) !== "free") continue;
      expect([...authGroupsOf(k, i)]).toEqual(["free"]);
    }
  });

  // kiro takes both oauth and an api key, but it lives in FREE_PROVIDERS, so
  // the Free chip is where a user looks for it. dualAuthTypes' kiro special
  // case is about counting its connections, not about which chip owns it.
  it("free-bucket providers are not dragged into the API Key chip by authModes", () => {
    if (!("kiro" in all)) return;
    expect([...authGroupsOf("kiro", all.kiro)]).toEqual(["free"]);
  });
});
