import { createRequire } from "node:module";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// On a graceful restart the drain runs the app's SIGTERM listeners in the order
// they were added. The database adapter's listener (close, then exit) is added
// when the DB opens, which can be before this repo is imported; its buffered
// rows must still be written before the close.

const require = createRequire(import.meta.url);
const { gateShutdownSignals } = require("../../server-drain.js");

const state = vi.hoisted(() => ({ events: [], closed: false, adapterGate: null }));

vi.mock("@/lib/db/driver.js", () => {
  const ensureOpen = () => {
    if (state.closed) throw new TypeError("The database connection is not open");
  };
  const db = {
    driver: "node:sqlite",
    transaction(fn) { ensureOpen(); return fn(); },
    run(sql, params = []) {
      ensureOpen();
      if (sql.startsWith("INSERT")) state.events.push(`insert ${params[0]}`);
      return { changes: 0 };
    },
    get() { ensureOpen(); return { c: 0 }; },
    all() { ensureOpen(); return []; },
  };
  return {
    getAdapter: async () => {
      if (state.adapterGate) await state.adapterGate;
      return db;
    },
  };
});

vi.mock("@/lib/db/repos/settingsRepo.js", () => ({
  getSettings: async () => ({
    enableObservability: true,
    observabilityBatchSize: 2,
    observabilityFlushIntervalMs: 60_000,
  }),
}));

const SIGNALS = ["SIGTERM", "SIGINT", "beforeExit", "exit"];
const before = Object.fromEntries(SIGNALS.map((name) => [name, process.listeners(name)]));
const realEmit = process.emit;
let repo;
let runSignalListeners;
let consoleError;

// Like the adapters: close the connection, then exit.
const closeDb = () => {
  state.events.push("close");
  state.closed = true;
  process.exit(0);
};

beforeAll(async () => {
  vi.stubEnv("ENABLE_REQUEST_LOGS", "true");
  runSignalListeners = gateShutdownSignals(process, () => {});
  process.on("SIGTERM", closeDb);
  repo = await import("@/lib/db/repos/requestDetailsRepo.js");
});

afterAll(() => {
  process.emit = realEmit;
  for (const name of SIGNALS) {
    for (const listener of process.listeners(name)) {
      if (!before[name].includes(listener)) process.off(name, listener);
    }
  }
  vi.unstubAllEnvs();
});

beforeEach(() => {
  state.events.length = 0;
  state.closed = false;
  state.adapterGate = null;
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  return () => consoleError.mockRestore();
});

describe("request details on shutdown", () => {
  it("writes the buffered rows before the adapter registered ahead of it closes the database", async () => {
    await repo.saveRequestDetail({ id: "last-row", model: "m" });
    expect(state.events).toEqual([]);

    await runSignalListeners("SIGTERM");

    expect(state.events).toEqual(["insert last-row", "close"]);
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("waits for a flush already running before the database closes", async () => {
    let open;
    state.adapterGate = new Promise((resolve) => { open = resolve; });
    await repo.saveRequestDetail({ id: "row-a", model: "m" });
    // The second row reaches the batch size and starts a flush, held at getAdapter.
    await repo.saveRequestDetail({ id: "row-b", model: "m" });
    setTimeout(open, 20);

    await runSignalListeners("SIGTERM");

    expect(state.events).toEqual(["insert row-a", "insert row-b", "close"]);
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("does not leave an exit listener that can't finish an async write", () => {
    const added = process.listeners("exit").filter((listener) => !before.exit.includes(listener));
    expect(added).toEqual([]);
  });
});
