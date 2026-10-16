import { afterEach, describe, expect, it, vi } from "vitest";
import { dashboardComponent, elements, textContent } from "../helpers/dashboardComponent.js";

afterEach(() => vi.unstubAllGlobals());
const saveButton = (tree) => elements(tree, (element) => element.type === "Button" && ["Save", "Saving..."].includes(textContent(element)))[0];

describe("shared combo form", () => {
  it("shows save failures and permits a subsequent retry", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ aliases: {} })));
    const component = dashboardComponent("src/shared/components/ComboFormModal.js");
    const props = { isOpen: true, combo: { name: "my-combo", models: ["provider/model"] }, onSave: vi.fn().mockRejectedValueOnce(new Error("Write failed")).mockResolvedValueOnce(undefined) };
    await saveButton(component.render(props)).props.onClick();
    const tree = component.render(props);
    expect(elements(tree, (element) => element.props?.role === "alert").map(textContent)).toEqual(["Write failed"]);
    expect(saveButton(tree).props.disabled).toBe(false);
    await saveButton(tree).props.onClick();
    expect(props.onSave).toHaveBeenCalledTimes(2);
    expect(elements(component.render(props), (element) => element.props?.role === "alert")).toHaveLength(0);
  });

  it("validates the same trimmed, prefixed name that it saves", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ aliases: {} })));
    const component = dashboardComponent("src/shared/components/ComboFormModal.js");
    const props = { isOpen: true, forcePrefix: "claude-", combo: { name: "claude- my-combo ", models: [] }, onSave: vi.fn() };
    await saveButton(component.render(props)).props.onClick();
    expect(props.onSave).toHaveBeenCalledWith({ name: "claude-my-combo", models: [] });
  });
});
