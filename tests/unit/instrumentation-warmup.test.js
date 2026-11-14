// Server boot warms the Codex catalog's model list after the auto-combo
// catalog, on the Node.js runtime only.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const calls = vi.hoisted(() => ({ order: [], finishAutoCombo: null }));
vi.mock("@/lib/consoleLogBuffer", () => ({ initConsoleLogCapture: () => {} }));
vi.mock("open-sse/providers/catalogOverride.js", () => ({ installCatalogSource: async () => {} }));
vi.mock("@/lib/modelCatalog/sync.js", () => ({ startModelCatalogSync: () => {} }));
vi.mock("@/sse/services/autoCombo.js", () => ({
  warmAutoComboCatalog: () => {
    calls.order.push("autoCombo:start");
    return new Promise((resolve) => { calls.finishAutoCombo = () => { calls.order.push("autoCombo:done"); resolve(); }; });
  },
}));
vi.mock("@/lib/codex/routedModels.js", () => ({ warmRoutedModels: () => { calls.order.push("routedModels"); } }));

const { register } = await import("@/instrumentation.js");
const originalRuntime = process.env.NEXT_RUNTIME;
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };

beforeEach(() => {
  calls.order = [];
  calls.finishAutoCombo = null;
});
afterEach(() => {
  if (originalRuntime === undefined) delete process.env.NEXT_RUNTIME;
  else process.env.NEXT_RUNTIME = originalRuntime;
});

describe("server boot", () => {
  it("warms the Codex model list once the auto-combo catalog is built, without blocking", async () => {
    process.env.NEXT_RUNTIME = "nodejs";
    await register();
    await settle();
    expect(calls.order).toEqual(["autoCombo:start"]);
    calls.finishAutoCombo();
    await settle();
    expect(calls.order).toEqual(["autoCombo:start", "autoCombo:done", "routedModels"]);
  });

  it("does nothing on the edge runtime", async () => {
    process.env.NEXT_RUNTIME = "edge";
    await register();
    await settle();
    expect(calls.order).toEqual([]);
  });
});
