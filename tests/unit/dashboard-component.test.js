import { describe, expect, it, vi } from "vitest";
import { dashboardComponent } from "../helpers/dashboardComponent.js";

describe("dashboardComponent hooks", () => {
  const probe = () => dashboardComponent("tests/helpers/fixtures/hookProbe.js");

  it("keeps a callback until its dependencies change", () => {
    const log = vi.fn();
    const component = probe();
    const first = component.render({ value: "a", log }).onValue;
    expect(component.render({ value: "a", log }).onValue).toBe(first);
    expect(component.render({ value: "b", log }).onValue).not.toBe(first);
  });

  it("runs a cleanup before its effect re-runs and on unmount, and runs effects without deps every render", () => {
    const log = vi.fn();
    const component = probe();
    component.render({ value: "a", log });
    component.render({ value: "a", log });
    component.render({ value: "b", log });
    component.unmount();
    expect(log.mock.calls.map(([entry]) => entry)).toEqual([
      "effect a", "every render",
      "every render",
      "cleanup a", "effect b", "every render",
      "cleanup b",
    ]);
  });

  it("keeps state and its setter across renders", () => {
    const log = vi.fn();
    const component = probe();
    const { setCount } = component.render({ value: "a", log });
    setCount((count) => count + 1);
    const next = component.render({ value: "a", log });
    expect(next.count).toBe(1);
    expect(next.setCount).toBe(setCount);
  });
});
