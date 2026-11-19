// The hung-model detector (open-sse/services/modelHang.js) on its own: what
// counts toward a hang, and how its windows and probes move.
import { describe, it, expect, beforeEach } from "vitest";

const { checkModelHang, noteHeadersTimeout, noteModelServed, noteProbeBudget, releaseProbe, clearModelHang } = await import("../../open-sse/services/modelHang.js");
const { HEADERS_TIMEOUT } = await import("../../open-sse/config/errorConfig.js");
const { UPSTREAM_STREAM_HEADERS_TIMEOUT_MS } = await import("../../open-sse/config/runtimeConfig.js");

const P = "acme";
const M = "big-model";
const T0 = 1_000_000_000_000;
const WINDOWS = HEADERS_TIMEOUT.hungWindowMs;
const [W0, W1] = WINDOWS;
const END = T0 + W0;
const timeout = (requestId, connectionId, now, stream = true) => noteHeadersTimeout(P, M, { requestId, connectionId, stream, reason: "no headers" }, now);
const check = (requestId, now) => checkModelHang(P, M, requestId, now);
// The probe starts, and its executor reports this headers budget at once.
const startProbe = (requestId, now, budgetMs) => {
  const result = check(requestId, now);
  if (budgetMs) noteProbeBudget(P, M, requestId, budgetMs, now);
  return result;
};
const blocked = (requestId, now) => check(requestId, now).blocked;

// Hung at T0 by requests r1 and r2 on keys a and b.
function hang() {
  timeout("r1", "a", T0);
  return timeout("r2", "b", T0);
}

beforeEach(() => clearModelHang());

describe("what marks a model hung", () => {
  it("takes stream timeouts from two requests on two keys", () => {
    expect(timeout("r1", "a", T0).hung).toBe(false);
    expect(hang()).toEqual({ hung: true, checking: false, retryAtMs: END, reason: "no headers" });
    expect(blocked("r3", T0 + 1)).toBe(true);
  });

  it("doesn't count one request timing out on two keys", () => {
    timeout("r1", "a", T0);
    expect(timeout("r1", "b", T0).hung).toBe(false);
  });

  it("doesn't count two requests timing out on the same key", () => {
    timeout("r1", "a", T0);
    expect(timeout("r2", "a", T0).hung).toBe(false);
    expect(timeout("r3", "b", T0).hung).toBe(true);
  });

  it("counts only streaming timeouts", () => {
    timeout("r1", "a", T0, false);
    expect(timeout("r2", "b", T0, false).hung).toBe(false);
    expect(blocked("r3", T0)).toBe(false);
  });

  it("doesn't add up timeouts more than resetAfterMs apart", () => {
    timeout("r1", "a", T0);
    expect(timeout("r2", "b", T0 + HEADERS_TIMEOUT.resetAfterMs + 1).hung).toBe(false);
  });

  it("has the next request try the keys that timed out last", () => {
    timeout("r1", "a", T0);
    expect(check("r2", T0 + 1)).toEqual({ blocked: false, probe: false, avoidKeys: ["a"] });
    expect(check("r2", T0 + HEADERS_TIMEOUT.resetAfterMs + 1).avoidKeys).toEqual([]);
  });

  it("forgets earlier timeouts once the model serves", () => {
    timeout("r1", "a", T0);
    noteModelServed(P, M);
    expect(check("r2", T0).avoidKeys).toEqual([]);
    expect(timeout("r2", "b", T0).hung).toBe(false);
  });
});

describe("a hung model's windows and probes", () => {
  it("lets one probe through after the window, and tells the rest when its budget runs out", () => {
    hang();
    expect(startProbe("p1", END, 90_000)).toEqual({ blocked: false, probe: true, avoidKeys: ["a", "b"] });
    expect(check("p1", END + 1).probe).toBe(true);
    expect(check("r3", END + 1)).toEqual({ blocked: true, checking: true, retryAtMs: END + 90_000, reason: "no headers" });
  });

  it("frees the probe slot when the probe is released, or when its lease runs out", () => {
    hang();
    check("p1", END);
    releaseProbe(P, M, "p1");
    expect(check("p2", END).probe).toBe(true);
    expect(blocked("p3", END + HEADERS_TIMEOUT.probeLeaseMs - 1)).toBe(true);
    expect(check("p3", END + HEADERS_TIMEOUT.probeLeaseMs).probe).toBe(true);
  });

  it("holds the slot for a probe with a long budget until that budget and a margin are past", () => {
    hang();
    const budgetMs = 2 * HEADERS_TIMEOUT.probeLeaseMs;
    startProbe("p1", END, budgetMs);
    expect(blocked("p2", END + budgetMs + HEADERS_TIMEOUT.probeLeaseMarginMs - 1)).toBe(true);
    expect(check("p2", END + budgetMs + HEADERS_TIMEOUT.probeLeaseMarginMs).probe).toBe(true);
  });

  it("tells the rest to come back shortly once the probe has outlived its budget but not its lease", () => {
    hang();
    startProbe("p1", END, 60_000);
    const now = END + 90_000;
    expect(check("r3", now)).toMatchObject({ blocked: true, checking: true, retryAtMs: now + 1000 });
  });

  it("goes by the budget the probe's executor reports, and only the probe's", () => {
    hang();
    check("p1", END);
    const budgetMs = 20 * 60 * 1000;
    noteProbeBudget(P, M, "p1", budgetMs, END);
    noteProbeBudget(P, M, "r9", 60_000, END);
    expect(check("r3", END + 1).retryAtMs).toBe(END + budgetMs);
    expect(blocked("r3", END + budgetMs + HEADERS_TIMEOUT.probeLeaseMarginMs - 1)).toBe(true);
    expect(check("r3", END + budgetMs + HEADERS_TIMEOUT.probeLeaseMarginMs).probe).toBe(true);
  });

  it("times the probe's next key from when it starts, with that key's budget", () => {
    hang();
    startProbe("p1", END, 60_000);
    // The first key failed fast; the second starts 50s in with a longer budget.
    noteProbeBudget(P, M, "p1", 240_000, END + 50_000);
    expect(check("r3", END + 100_000).retryAtMs).toBe(END + 50_000 + 240_000);
  });

  it("moves to the next window only on the probe's own timeout", () => {
    hang();
    startProbe("p1", END, 90_000);
    // A request sent before the hang times out after the window: a check is running.
    expect(timeout("r9", "c", END + 1)).toEqual({ hung: true, checking: true, retryAtMs: END + 90_000, reason: "no headers" });
    expect(timeout("p1", "c", END + 2)).toMatchObject({ hung: true, checking: false, retryAtMs: END + 2 + W1 });
  });

  it("moves to the next window on the probe's non-streaming timeout too", () => {
    hang();
    check("p1", END);
    expect(timeout("p1", "c", END + 1, false)).toMatchObject({ hung: true, checking: false, retryAtMs: END + 1 + W1 });
  });

  it("never tells a late request to come back at a time already past", () => {
    hang();
    const now = END + 5000;
    expect(timeout("r9", "c", now).retryAtMs).toBe(now + UPSTREAM_STREAM_HEADERS_TIMEOUT_MS);
  });

  it("stays at the last window once the probes have timed out past it", () => {
    hang();
    let now = END;
    const waits = [];
    for (let i = 0; i < WINDOWS.length + 2; i++) {
      check(`p${i}`, now);
      const { retryAtMs } = timeout(`p${i}`, "c", now);
      waits.push(retryAtMs - now);
      now = retryAtMs;
    }
    expect(waits).toEqual([...WINDOWS.slice(1), WINDOWS.at(-1), WINDOWS.at(-1), WINDOWS.at(-1)]);
  });

  it("has the probe try keys that timed out during the hang last", () => {
    hang();
    timeout("r9", "c", T0 + 1);
    expect(check("p1", END).avoidKeys).toEqual(["a", "b", "c"]);
  });

  it("starts the windows over for a probe that times out long after its window", () => {
    hang();
    const late = END + HEADERS_TIMEOUT.resetAfterMs + 1;
    check("p1", late);
    expect(timeout("p1", "a", late).retryAtMs).toBe(late + W0);
  });

  it("ends when the model serves", () => {
    hang();
    noteModelServed(P, M);
    expect(blocked("r3", T0 + 1)).toBe(false);
  });
});
