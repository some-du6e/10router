// The Proxy routing card follows the dashboard save rules: nothing is drawn or
// editable before pools, settings and accounts load, a load failure says why,
// and a failed write reaches the user and releases the pending state.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dashboardComponent, elements, textContent } from "../helpers/dashboardComponent.js";
import api from "@/shared/utils/api.js";
import * as routing from "../../src/lib/network/proxyRouting.ts";

const notify = { error: vi.fn(), success: vi.fn() };
const stub = (name) => Object.assign((props) => props?.children ?? null, { displayName: name });
const Select = stub("Select");
const imports = {
  "@/shared/components/index.js": { __esModule: true, Badge: stub("Badge"), Button: stub("Button"), Card: stub("Card"), Select, ConfirmModal: stub("ConfirmModal") },
  "@/shared/components/ProviderIcon.js": { __esModule: true, default: stub("ProviderIcon") },
  "@/shared/hooks/useBlurEmails.js": { __esModule: true, useBlurEmails: () => ({ blurClass: "" }) },
  "@/shared/constants/providers.js": { __esModule: true, AI_PROVIDERS: { codex: { name: "Codex" } } },
  "@/store/notificationStore.js": { __esModule: true, useNotificationStore: () => notify },
  "@/shared/utils/api.js": { __esModule: true, default: api },
  "@/lib/network/proxyRouting.js": { __esModule: true, ...routing },
};
const path = "src/app/(dashboard)/dashboard/proxy-pools/ProxyRoutingCard.tsx";
const pools = [{ id: "eu", name: "Residential EU", proxyUrl: "http://eu.proxy.test:3128", isActive: true, strictProxy: true }];
const accounts = { connections: [{ id: "a1", provider: "codex", name: "Work", providerSpecificData: { proxyPoolId: "eu" } }] };

const selects = (tree) => elements(tree, (el) => el.type === Select);
let responses;
beforeEach(() => {
  vi.clearAllMocks();
  responses = { "/api/providers": () => Response.json(accounts), "/api/settings": () => Response.json({ providerStrategies: {} }) };
  vi.stubGlobal("fetch", vi.fn(async (url) => (responses[String(url).split("?")[0]] || (() => Response.json({})))()));
});
afterEach(() => vi.unstubAllGlobals());

describe("Proxy routing card", () => {
  it("draws nothing until the pools load, so no bound account shows as blocked", async () => {
    const card = dashboardComponent(path, imports);
    const loading = { proxyPools: [], poolsLoaded: false, onPoolsChanged: vi.fn() };
    card.render(loading);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    await new Promise((r) => setTimeout(r, 10));
    expect(card.render(loading)).toBeNull();
    const loaded = { ...loading, proxyPools: pools, poolsLoaded: true };
    await vi.waitFor(() => expect(selects(card.render(loaded))).toHaveLength(1));
    expect(textContent(card.render(loaded))).not.toContain("no longer exists");
  });

  it("says why when the pools or the settings didn't load, and offers no controls", async () => {
    const card = dashboardComponent(path, imports);
    const failed = { proxyPools: [], poolsLoaded: false, poolsError: "Database unavailable", onPoolsChanged: vi.fn() };
    card.render(failed);
    await vi.waitFor(() => expect(textContent(card.render(failed))).toContain("Database unavailable"));
    expect(selects(card.render(failed))).toHaveLength(0);

    responses["/api/settings"] = () => Response.json({ error: "Settings locked" }, { status: 500 });
    const other = dashboardComponent(path, imports);
    const props = { proxyPools: pools, poolsLoaded: true, onPoolsChanged: vi.fn() };
    other.render(props);
    await vi.waitFor(() => expect(textContent(other.render(props))).toContain("Settings locked"));
    expect(selects(other.render(props))).toHaveLength(0);
  });

  it("shows a refused save and releases the pending state", async () => {
    const card = dashboardComponent(path, imports);
    const props = { proxyPools: pools, poolsLoaded: true, onPoolsChanged: vi.fn() };
    card.render(props);
    await vi.waitFor(() => expect(selects(card.render(props))).toHaveLength(1));
    responses["/api/providers/a1"] = () => Response.json({ error: "Proxy pool not found" }, { status: 400 });
    await selects(card.render(props))[0].props.onChange({ target: { value: "__direct__" } });
    await vi.waitFor(() => expect(notify.error).toHaveBeenCalledWith("Proxy pool not found"));
    await vi.waitFor(() => expect(selects(card.render(props))[0].props.disabled).toBe(false));
    expect(props.onPoolsChanged).toHaveBeenCalled();
  });
});

describe("Proxy routing card provider panel", () => {
  it("lists accounts that fall through to Global apart from those with their own setting", async () => {
    responses["/api/providers"] = () => Response.json({ connections: [
      { id: "own", provider: "codex", name: "Own pool", providerSpecificData: { proxyPoolId: "eu" } },
      { id: "inh", provider: "codex", name: "Inheriting", providerSpecificData: {} },
    ] });
    responses["/api/settings"] = () => Response.json({ providerStrategies: {}, globalProxyPoolId: "eu" });
    const card = dashboardComponent(path, imports);
    const props = { proxyPools: pools, poolsLoaded: true, onPoolsChanged: vi.fn() };
    card.render(props);
    await vi.waitFor(() => expect(selects(card.render(props))).toHaveLength(1));
    const providerBlock = elements(card.render(props), (el) => el.type === "button" && textContent(el).startsWith("Codex"))[0];
    providerBlock.props.onClick();
    const text = textContent(card.render(props));
    expect(text).toMatch(/Set their own.*Own pool/);
    expect(text).toMatch(/Use Global.*Inheriting/);
    expect(text).not.toMatch(/Set their own[^]*Inheriting[^]*Use Global/);
  });

  it("on the Global panel, lists accounts their provider decides under their provider", async () => {
    const us = { id: "us", name: "US East", proxyUrl: "http://us.proxy.test:8080", isActive: true, strictProxy: true };
    responses["/api/providers"] = () => Response.json({ connections: [{ id: "inh", provider: "codex", name: "Inheriting", providerSpecificData: {} }] });
    responses["/api/settings"] = () => Response.json({ providerStrategies: { codex: { proxyPoolId: "us" } }, globalProxyPoolId: "eu" });
    const card = dashboardComponent(path, imports);
    const props = { proxyPools: [...pools, us], poolsLoaded: true, onPoolsChanged: vi.fn() };
    card.render(props);
    await vi.waitFor(() => expect(selects(card.render(props))).toHaveLength(1));
    elements(card.render(props), (el) => el.type === "button" && textContent(el).startsWith("Global"))[0].props.onClick();
    const text = textContent(card.render(props));
    expect(text).toMatch(/Set by their provider.*Inheriting/);
    expect(text).not.toContain("Use Global");
  });
});
