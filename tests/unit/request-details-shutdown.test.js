import { createRequire } from "node:module";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// On a graceful restart the drain runs the app's SIGTERM listeners in the order
// they were added. The database adapter's listener (close, then exit) is added
// when the DB opens, which can be before this repo is imported; its buffered
// rows must still be written before the close.

const require = createRequire(import.meta.url);
const { gateShutdownSignals } = require("../../server-drain.js");

const state = vi.hoisted(() => ({
  events: [],
  fullData: {},
  closed: false,
  adapterGates: [],
  onTransaction: null,
}));

vi.mock("@/lib/db/driver.js", () => {
  const ensureOpen = () => {
    if (state.closed) throw new TypeError("The database connection is not open");
  };
  const db = {
    driver: "node:sqlite",
    transaction(fn) {
      ensureOpen();
      const result = fn();
      const hook = state.onTransaction;
      state.onTransaction = null;
      hook?.();
      return result;
    },
    run(sql, params = []) {
      ensureOpen();
      if (sql.startsWith("INSERT")) {
        state.events.push(`insert ${params[0]}`);
        state.fullData[params[0]] = params[7];
      }
      return { changes: 0 };
    },
    get() { ensureOpen(); return { c: 0 }; },
    all() { ensureOpen(); return []; },
  };
  return {
    // Each call waits on the next queued gate, if any.
    getAdapter: async () => {
      const gate = state.adapterGates.shift();
      if (gate) await gate;
      return db;
    },
  };
});

// Full payloads on: rows over the size cap also get a gzipped full copy.
vi.mock("@/lib/db/repos/settingsRepo.js", () => ({
  getSettings: async () => ({
    enableObservability: true,
    showSensitiveRequestDetails: true,
    observabilityBatchSize: 2,
    observabilityFlushIntervalMs: 60_000,
  }),
}));

function gate() {
  let open;
  const promise = new Promise((resolve) => { open = resolve; });
  return { promise, open };
}

// Over the 128 KB cap that applies with full payloads on.
const bigRow = (id) => ({ id, model: "m", request: { messages: [{ role: "user", content: "x".repeat(200_000) }] } });

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
  state.fullData = {};
  state.closed = false;
  state.adapterGates = [];
  state.onTransaction = null;
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  return () => consoleError.mockRestore();
});

describe("request details on shutdown", () => {
  // Must run first: once a signal has run, the repo stays in shutdown mode.
  it("stops packing full payloads in a running flush once shutdown starts", async () => {
    const first = gate();
    const second = gate();
    state.adapterGates = [first.promise, second.promise];
    await repo.saveRequestDetail(bigRow("big-a"));
    await repo.saveRequestDetail(bigRow("big-b")); // starts a flush, held at the first gate
    await repo.saveRequestDetail(bigRow("big-c")); // left for that flush's next pass
    first.open();
    // The first pass, before any signal, keeps full payloads.
    await vi.waitFor(() => expect(state.events).toEqual(["insert big-a", "insert big-b"]));
    expect(typeof state.fullData["big-a"]).toBe("string");
    expect(typeof state.fullData["big-b"]).toBe("string");

    // The next pass is held at the second gate when the signal arrives.
    setTimeout(second.open, 20);
    await runSignalListeners("SIGTERM");

    expect(state.events).toEqual(["insert big-a", "insert big-b", "insert big-c", "close"]);
    expect(state.fullData["big-c"]).toBeNull();
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("writes the buffered rows before the adapter registered ahead of it closes the database", async () => {
    await repo.saveRequestDetail({ id: "last-row", model: "m" });
    expect(state.events).toEqual([]);

    await runSignalListeners("SIGTERM");

    expect(state.events).toEqual(["insert last-row", "close"]);
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("waits for a flush already running before the database closes", async () => {
    const held = gate();
    state.adapterGates = [held.promise];
    await repo.saveRequestDetail({ id: "row-a", model: "m" });
    // The second row reaches the batch size and starts a flush, held at getAdapter.
    await repo.saveRequestDetail({ id: "row-b", model: "m" });
    setTimeout(held.open, 20);

    await runSignalListeners("SIGTERM");

    expect(state.events).toEqual(["insert row-a", "insert row-b", "close"]);
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("writes a batch saved while the previous flush is finishing, with no further save or signal", async () => {
    // Runs inside the flush's last transaction; both saves push a tick later,
    // after that flush has found the buffer empty.
    state.onTransaction = () => {
      repo.saveRequestDetail({ id: "late-a", model: "m" });
      repo.saveRequestDetail({ id: "late-b", model: "m" });
    };
    await repo.saveRequestDetail({ id: "row-1", model: "m" });
    await repo.saveRequestDetail({ id: "row-2", model: "m" });

    await vi.waitFor(() => expect(state.events).toEqual(["insert row-1", "insert row-2", "insert late-a", "insert late-b"]));
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("does not leave an exit listener that can't finish an async write", () => {
    const added = process.listeners("exit").filter((listener) => !before.exit.includes(listener));
    expect(added).toEqual([]);
  });
});
