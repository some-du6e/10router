import { afterEach, describe, expect, it, vi } from "vitest";
import { dashboardComponent, dashboardHandler, elements, textContent } from "../helpers/dashboardComponent.js";
import api from "@/shared/utils/api.js";
import PropTypes from "prop-types";

afterEach(() => vi.unstubAllGlobals());
const imports = {
  "@/shared/utils/api": { __esModule: true, default: api },
  "prop-types": { __esModule: true, default: PropTypes },
};
const alerts = (tree) => elements(tree, (element) => element.props?.role === "alert").map(textContent).join(" ");
const selects = (tree) => elements(tree, (element) => element.type === "Select" || element.type === "select");
const saved = (tree) => elements(tree, (element) => element.type === "Badge" && textContent(element) === "Saved");
const proxyPath = "src/shared/components/NoAuthProxyCard.js";
const pools = { proxyPools: [{ id: "pool-a", name: "A" }, { id: "pool-b", name: "B" }] };
const settings = { providerStrategies: { other: { proxyPoolId: "untouched" }, local: { proxyPoolId: "pool-a" } } };

describe("dashboard save and reauthentication followups", () => {
  it("shows a rejected route-group combo save and permits retry", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ aliases: {} })));
    const component = dashboardComponent("src/app/(dashboard)/dashboard/combos/page.js", {
      "@/shared/components": { Button: "Button", Modal: "Modal", Input: "Input" },
      "@dnd-kit/core": { useSensors: () => [], useSensor: () => ({}) },
    }, "ComboFormModal");
    const props = { isOpen: true, combo: { name: " my-combo ", models: [] }, onSave: vi.fn().mockRejectedValueOnce(new Error("Write refused")).mockResolvedValueOnce(undefined) };
    const button = (tree) => elements(tree, (element) => element.type === "Button" && ["Save", "Saving..."].includes(textContent(element)))[0];
    await button(component.render(props)).props.onClick();
    expect(alerts(component.render(props))).toContain("Write refused");
    expect(button(component.render(props)).props.disabled).toBe(false);
    await button(component.render(props)).props.onClick();
    expect(props.onSave).toHaveBeenCalledTimes(2);
    expect(props.onSave).toHaveBeenLastCalledWith({ name: "my-combo", models: [] });
    expect(alerts(component.render(props))).toBe("");
  });

  it.each(["/api/settings", "/api/proxy-pools?isActive=true"])("blocks proxy editing when %s fails to load", async (failedUrl) => {
    const fetch = vi.fn(async (url) => url === failedUrl
      ? Response.json({ error: "Read refused" }, { status: 403 })
      : Response.json(url.includes("proxy-pools") ? pools : settings));
    vi.stubGlobal("fetch", fetch);
    const component = dashboardComponent(proxyPath, imports);
    const props = { providerId: "local" };
    component.render(props);
    await vi.waitFor(() => expect(alerts(component.render(props))).toContain("Read refused"));
    expect(selects(component.render(props)).every((select) => select.props.disabled)).toBe(true);
    await selects(component.render(props))[0].props.onChange({ target: { value: "pool-b" } });
    expect(fetch.mock.calls.every(([, options]) => options.method === "GET")).toBe(true);
    expect(saved(component.render(props))).toHaveLength(0);
  });

  it.each(["read", "patch"])("retains the saved proxy value when the save %s fails and permits retry", async (failure) => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json(pools))
      .mockResolvedValueOnce(Response.json(settings))
      .mockResolvedValueOnce(failure === "read" ? new Response("Unavailable", { status: 503 }) : Response.json(settings));
    if (failure === "patch") fetch.mockResolvedValueOnce(Response.json({ error: "Write refused" }, { status: 403 }));
    fetch.mockResolvedValueOnce(Response.json(settings)).mockResolvedValueOnce(Response.json({}));
    vi.stubGlobal("fetch", fetch);
    const component = dashboardComponent(proxyPath, imports);
    const props = { providerId: "local" };
    component.render(props);
    await vi.waitFor(() => expect(selects(component.render(props))[0].props.value).toBe("pool-a"));
    await selects(component.render(props))[0].props.onChange({ target: { value: "pool-b" } });
    expect(alerts(component.render(props))).toContain(failure === "read" ? "503" : "Write refused");
    expect(selects(component.render(props))[0].props.value).toBe("pool-a");
    expect(selects(component.render(props))[0].props.disabled).toBe(false);
    expect(saved(component.render(props))).toHaveLength(0);
    if (failure === "read") expect(fetch.mock.calls.every(([, options]) => options.method === "GET")).toBe(true);
    await selects(component.render(props))[0].props.onChange({ target: { value: "pool-b" } });
    expect(selects(component.render(props))[0].props.value).toBe("pool-b");
    expect(saved(component.render(props))).toHaveLength(1);
    expect(JSON.parse(fetch.mock.calls.at(-1)[1].body)).toEqual({
      providerStrategies: { other: { proxyPoolId: "untouched" }, local: { proxyPoolId: "pool-b" } },
    });
  });

  it.each([undefined, { connection: { id: "different-account" } }])("keeps the selected account error when sign-in does not confirm its identity %#", async (result) => {
    const fetch = vi.fn().mockResolvedValue(Response.json({}));
    const scope = { reauthConnectionId: "selected-account", fetch, fetchConnections: vi.fn(), setShowOAuthModal: vi.fn(), setReauthConnectionId: vi.fn(), window: { alert: vi.fn() } };
    await dashboardHandler("src/app/(dashboard)/dashboard/providers/[id]/page.js", "handleOAuthSuccess", scope)(result);
    expect(fetch).not.toHaveBeenCalled();
    expect(scope.fetchConnections).toHaveBeenCalledOnce();
    expect(scope.window.alert).toHaveBeenCalledWith(expect.stringContaining("existing error was kept"));
  });

  it.each([{ connection: { id: "selected-account" } }, { connectionId: "selected-account" }])("clears the previous error only for the account that received credentials %#", async (result) => {
    const fetch = vi.fn().mockResolvedValue(Response.json({}));
    const scope = { reauthConnectionId: "selected-account", fetch, fetchConnections: vi.fn(), setShowOAuthModal: vi.fn(), setReauthConnectionId: vi.fn(), window: { alert: vi.fn() } };
    await dashboardHandler("src/app/(dashboard)/dashboard/providers/[id]/page.js", "handleOAuthSuccess", scope)(result);
    expect(fetch).toHaveBeenCalledWith("/api/providers/selected-account", expect.objectContaining({ method: "PUT" }));
    expect(scope.fetchConnections).toHaveBeenCalledOnce();
    expect(scope.window.alert).not.toHaveBeenCalled();
  });

  it("forwards the saved OAuth connection identity to the parent callback", async () => {
    const result = { connection: { id: "saved-account" } };
    const scope = {
      authData: { redirectUri: "http://localhost/callback", codeVerifier: "verifier" },
      provider: "codex", oauthMeta: null, useCallback: (callback) => callback,
      fetch: vi.fn().mockResolvedValue(Response.json(result)), onSuccess: vi.fn(), setStep: vi.fn(), setError: vi.fn(),
    };
    await dashboardHandler("src/shared/components/OAuthModal.js", "exchangeTokens", scope)("code", "state");
    expect(scope.onSuccess).toHaveBeenCalledWith(result);
    expect(scope.setError).not.toHaveBeenCalled();
  });

  it.each(["handleSocialSuccess", "handleDeviceSuccess"])("retains the account identity through Kiro's %s wrapper", (name) => {
    const result = { connection: { id: "saved-account" } };
    const scope = { setAuthMethod: vi.fn(), setSocialProvider: vi.fn(), setIdcConfig: vi.fn(), onSuccess: vi.fn(), onClose: vi.fn() };
    dashboardHandler("src/shared/components/KiroOAuthWrapper.js", name, scope)(result);
    expect(scope.onSuccess).toHaveBeenCalledWith(result);
    expect(scope.onClose).toHaveBeenCalledOnce();
  });

  it.each(["import", "import-cli-proxy", "api-key"])("forwards Kiro's saved account after %s", (method) => {
    const result = { connection: { id: "saved-account" } };
    const scope = { setAuthMethod: vi.fn(), setSocialProvider: vi.fn(), setIdcConfig: vi.fn(), onSuccess: vi.fn(), useCallback: (callback) => callback };
    dashboardHandler("src/shared/components/KiroOAuthWrapper.js", "handleMethodSelect", scope)(method, result);
    expect(scope.onSuccess).toHaveBeenCalledWith(result);
  });
});
