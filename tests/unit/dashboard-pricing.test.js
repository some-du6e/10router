import { afterEach, describe, expect, it, vi } from "vitest";
import { dashboardComponent, elements, textContent } from "../helpers/dashboardComponent.js";
import api from "@/shared/utils/api.js";

afterEach(() => vi.unstubAllGlobals());

const initialPricing = { provider: { model: { input: 2, output: 4 } } };
const modalPath = "src/shared/components/PricingModal.js";
const imports = {
  "@/shared/utils/api": { __esModule: true, default: api },
  "open-sse/providers/pricing.js": { getDefaultPricing: () => initialPricing },
  "next/navigation": { useRouter: () => ({}) },
};
const button = (tree, text) => elements(tree, (element) => element.type === "button" && textContent(element) === text)[0];
const alerts = (tree) => elements(tree, (element) => element.props?.role === "alert").map(textContent).join(" ");

describe("pricing settings failure states", () => {
  it("shows load failures and prevents saving a default replacement", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ error: "Database unavailable" }, { status: 500 }));
    vi.stubGlobal("fetch", fetch);
    const component = dashboardComponent(modalPath, imports);
    const props = { isOpen: true, onClose: vi.fn() };
    component.render(props);
    await vi.waitFor(() => expect(button(component.render(props), "Save Changes").props.disabled).toBe(true));
    await vi.waitFor(() => expect(alerts(component.render(props))).toContain("Database unavailable"));
    await button(component.render(props), "Save Changes").props.onClick();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("keeps a failed save open and allows retry, including non-JSON failures", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(Response.json(initialPricing))
      .mockResolvedValueOnce(new Response("Proxy error", { status: 502 }))
      .mockResolvedValueOnce(Response.json(initialPricing));
    vi.stubGlobal("fetch", fetch);
    vi.stubGlobal("alert", vi.fn());
    const component = dashboardComponent(modalPath, imports);
    const props = { isOpen: true, onClose: vi.fn(), onSave: vi.fn() };
    component.render(props);
    await vi.waitFor(() => expect(elements(component.render(props), (element) => element.type === "input")).toHaveLength(5));
    await button(component.render(props), "Save Changes").props.onClick();
    expect(props.onClose).not.toHaveBeenCalled();
    expect(alerts(component.render(props))).toContain("502");
    expect(button(component.render(props), "Save Changes").props.disabled).toBe(false);
    await button(component.render(props), "Save Changes").props.onClick();
    expect(props.onClose).toHaveBeenCalledOnce();
    expect(props.onSave).toHaveBeenCalledOnce();
  });

  it("uses reset pricing from the server and refreshes the parent", async () => {
    const resetPricing = { provider: { model: { input: 9 } } };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(Response.json(initialPricing)).mockResolvedValueOnce(Response.json(resetPricing)));
    vi.stubGlobal("confirm", () => true);
    const component = dashboardComponent(modalPath, imports);
    const props = { isOpen: true, onSave: vi.fn() };
    component.render(props);
    await vi.waitFor(() => expect(elements(component.render(props), (element) => element.type === "input")).toHaveLength(5));
    await button(component.render(props), "Reset to Defaults").props.onClick();
    expect(elements(component.render(props), (element) => element.type === "input")[0].props.value).toBe(9);
    expect(props.onSave).toHaveBeenCalledOnce();
  });

  it("reports reset failures and releases the pending state", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(Response.json(initialPricing)).mockResolvedValueOnce(Response.json({ error: "Reset refused" }, { status: 403 })));
    vi.stubGlobal("confirm", () => true);
    const component = dashboardComponent(modalPath, imports);
    const props = { isOpen: true };
    component.render(props);
    await vi.waitFor(() => expect(elements(component.render(props), (element) => element.type === "input")).toHaveLength(5));
    await button(component.render(props), "Reset to Defaults").props.onClick();
    expect(alerts(component.render(props))).toContain("Reset refused");
    expect(button(component.render(props), "Save Changes").props.disabled).toBe(false);
  });

  it("does not mutate the previously loaded pricing object", async () => {
    const pricing = Object.freeze({ provider: Object.freeze({ model: Object.freeze({ input: 2 }) }) });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => pricing }));
    const component = dashboardComponent(modalPath, imports);
    const props = { isOpen: true };
    component.render(props);
    await vi.waitFor(() => expect(elements(component.render(props), (element) => element.type === "input")).toHaveLength(5));
    elements(component.render(props), (element) => element.type === "input")[0].props.onChange({ target: { value: "3" } });
    expect(elements(component.render(props), (element) => element.type === "input")[0].props.value).toBe(3);
    expect(pricing.provider.model.input).toBe(2);
  });

  it("shows an unavailable status when the settings page cannot load pricing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ error: "Database unavailable" }, { status: 500 })));
    const component = dashboardComponent("src/app/dashboard/settings/pricing/page.js", imports);
    component.render({});
    await vi.waitFor(() => expect(alerts(component.render({}))).toContain("Database unavailable"));
    expect(textContent(component.render({}))).toContain("Unavailable");
  });
});
