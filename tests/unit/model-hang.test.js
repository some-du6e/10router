// The hung-model detector (open-sse/services/modelHang.js) on its own: what
// counts toward a hang, and how its windows and probes move.
import { describe, it, expect, beforeEach } from "vitest";

const { checkModelHang, noteHeadersTimeout, noteModelServed, releaseProbe, clearModelHang } = await import("../../open-sse/services/modelHang.js");
const { HEADERS_TIMEOUT } = await import("../../open-sse/config/errorConfig.js");
const { UPSTREAM_STREAM_HEADERS_TIMEOUT_MS } = await import("../../open-sse/config/runtimeConfig.js");

const P = "acme";
const M = "big-model";
const T0 = 1_000_000_000_000;
const [W0, W1] = HEADERS_TIMEOUT.hungWindowMs;
const timeout = (requestId, connectionId, now, stream = true) => noteHeadersTimeout(P, M, { requestId, connectionId, stream, reason: "no headers" }, now);
const blocked = (requestId, now) => checkModelHang(P, M, requestId, now).blocked;

// Hung at T0 by requests r1 and r2 on keys a and b.
function hang() {
  timeout("r1", "a", T0);
  return timeout("r2", "b", T0);
}

beforeEach(() => clearModelHang());

describe("what marks a model hung", () => {
  it("takes timeouts from two requests on two keys", () => {
    expect(timeout("r1", "a", T0).hung).toBe(false);
    expect(hang()).toEqual({ hung: true, retryAtMs: T0 + W0 });
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
    expect(checkModelHang(P, M, "r2", T0 + 1)).toEqual({ blocked: false, probe: false, avoidKeys: ["a"] });
    expect(checkModelHang(P, M, "r2", T0 + HEADERS_TIMEOUT.resetAfterMs + 1).avoidKeys).toEqual([]);
  });

  it("forgets earlier timeouts once the model serves", () => {
    timeout("r1", "a", T0);
    noteModelServed(P, M);
    expect(checkModelHang(P, M, "r2", T0).avoidKeys).toEqual([]);
    expect(timeout("r2", "b", T0).hung).toBe(false);
  });
});

describe("a hung model's windows and probes", () => {
  it("lets one probe through after the window, and blocks the rest while it runs", () => {
    hang();
    const end = T0 + W0;
    expect(checkModelHang(P, M, "p1", end)).toEqual({ blocked: false, probe: true, avoidKeys: ["a", "b"] });
    expect(checkModelHang(P, M, "p1", end + 1).probe).toBe(true);
    expect(checkModelHang(P, M, "r3", end + 1)).toMatchObject({ blocked: true, checking: true, retryAtMs: end + UPSTREAM_STREAM_HEADERS_TIMEOUT_MS });
  });

  it("frees the probe slot when the probe is released, or when its lease runs out", () => {
    hang();
    const end = T0 + W0;
    checkModelHang(P, M, "p1", end);
    releaseProbe(P, M, "p1");
    expect(checkModelHang(P, M, "p2", end).probe).toBe(true);
    expect(blocked("p3", end + HEADERS_TIMEOUT.probeLeaseMs - 1)).toBe(true);
    expect(checkModelHang(P, M, "p3", end + HEADERS_TIMEOUT.probeLeaseMs).probe).toBe(true);
  });

  it("moves to the next window only on the probe's own timeout", () => {
    hang();
    const end = T0 + W0;
    checkModelHang(P, M, "p1", end);
    // A request sent before the hang times out now: nothing changes.
    expect(timeout("r9", "c", end + 1)).toEqual({ hung: true, retryAtMs: end });
    expect(timeout("p1", "c", end + 2)).toEqual({ hung: true, retryAtMs: end + 2 + W1 });
  });

  it("keeps the probe's slot after its non-streaming timeout", () => {
    hang();
    const end = T0 + W0;
    checkModelHang(P, M, "p1", end);
    expect(timeout("p1", "c", end + 1, false)).toEqual({ hung: true, retryAtMs: end });
  });

  it("has the probe try keys that timed out during the hang last", () => {
    hang();
    timeout("r9", "c", T0 + 1);
    expect(checkModelHang(P, M, "p1", T0 + W0).avoidKeys).toEqual(["a", "b", "c"]);
  });

  it("starts the windows over for a probe that times out long after its window", () => {
    hang();
    const late = T0 + W0 + HEADERS_TIMEOUT.resetAfterMs + 1;
    checkModelHang(P, M, "p1", late);
    expect(timeout("p1", "a", late).retryAtMs).toBe(late + W0);
  });

  it("ends when the model serves", () => {
    hang();
    noteModelServed(P, M);
    expect(blocked("r3", T0 + 1)).toBe(false);
  });
});
