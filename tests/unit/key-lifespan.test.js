// Key lifespan estimate: an active key's remaining budget, learned from what
// earlier keys of the same provider consumed before they were turned off
// automatically. Math first, then the repo against a temp SQLite DB.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  estimateKeyLifespans, lifespanLabel, percentile,
} from "../../src/shared/utils/keyLifespan.js";
import { withLifespans, withToggledActive } from "../../src/app/(dashboard)/dashboard/providers/utils.js";
import { SOFT_DEMOTE_PREFIX } from "../../src/shared/utils/connectionStatus.js";

const NOW = Date.parse("2026-11-04T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const iso = (ms) => new Date(ms).toISOString();
const dead = (id) => ({ id, isActive: false, autoDisabledAt: "2026-11-03T00:00:00.000Z" });
const live = (id) => ({ id, isActive: true });

// The Snowflake keys: nine died between $419 and $717, one died early at $42
// (an "account locked" 401), and the live key is at $230.
const SNOWFLAKE = [419, 419, 454, 529, 552, 565, 646, 655, 717];
function snowflake(liveUsage = { cost: 230, tokens: 1e6, recentCost: 0, recentTokens: 0, firstAt: iso(NOW - 30 * HOUR) }) {
  const connections = [...SNOWFLAKE.map((_, i) => dead(`d${i}`)), dead("locked"), live("k")];
  const usage = Object.fromEntries(SNOWFLAKE.map((cost, i) => [`d${i}`, { cost, tokens: cost * 1000 }]));
  usage.locked = { cost: 42, tokens: 42000 };
  usage.k = liveUsage;
  return { connections, usage };
}

describe("percentile", () => {
  it("interpolates between neighbours", () => {
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(percentile([10], 0.75)).toBe(10);
    expect(percentile([], 0.5)).toBeNull();
  });
});

describe("estimateKeyLifespans", () => {
  it("uses the median and p25-p75 of the dead keys, ignoring the one that died early", () => {
    const { connections, usage } = snowflake();
    const { estimate, keys } = estimateKeyLifespans(connections, usage, { now: NOW });
    expect(estimate).toEqual({ metric: "cost", median: 552, low: 454, high: 646, sampleSize: 9, excluded: 1 });
    expect(keys.k).toMatchObject({ used: 230, budget: 552, remaining: 322, low: 454, high: 646 });
    expect(Math.round(keys.k.percentLeft)).toBe(58);
    expect(Object.keys(keys)).toEqual(["k"]);
  });

  it("gives no estimate with fewer than 3 dead keys", () => {
    const usage = { a: { cost: 500 }, b: { cost: 600 }, k: { cost: 10 } };
    expect(estimateKeyLifespans([dead("a"), dead("b"), live("k")], usage, { now: NOW })).toEqual({ estimate: null, keys: {} });
  });

  it("gives no estimate when outliers leave fewer than 3 dead keys", () => {
    const usage = { a: { cost: 500 }, b: { cost: 600 }, c: { cost: 50 }, d: { cost: 40 }, e: { cost: 700 } };
    expect(estimateKeyLifespans(["a", "b", "c", "d", "e"].map(dead), usage, { now: NOW }).estimate)
      .toMatchObject({ sampleSize: 3, excluded: 2, median: 600 });
    expect(estimateKeyLifespans(["a", "b", "c", "d"].map(dead), usage, { now: NOW }).estimate).toBeNull();
  });

  it("only counts keys turned off automatically as dead", () => {
    const connections = [{ id: "a", isActive: false }, { id: "b", isActive: false }, dead("c"), dead("d"), live("k")];
    const usage = { a: { cost: 500 }, b: { cost: 500 }, c: { cost: 500 }, d: { cost: 500 } };
    expect(estimateKeyLifespans(connections, usage, { now: NOW }).estimate).toBeNull();
  });

  it("falls back to tokens when a dead key has no cost", () => {
    const usage = {
      a: { cost: 0, tokens: 1000 }, b: { cost: 3, tokens: 2000 }, c: { tokens: 3000 },
      k: { cost: 1, tokens: 500, recentCost: 1, recentTokens: 300, firstAt: iso(NOW - 30 * HOUR) },
    };
    const { estimate, keys } = estimateKeyLifespans([dead("a"), dead("b"), dead("c"), live("k")], usage, { now: NOW });
    expect(estimate).toMatchObject({ metric: "tokens", median: 2000, low: 1500, high: 2500 });
    expect(keys.k).toMatchObject({ metric: "tokens", used: 500, remaining: 1500 });
    // The pace is in tokens too: 300 over the 6h window.
    expect(keys.k.ratePerHour).toBeCloseTo(50);
    expect(keys.k.etaHours).toBeCloseTo(30);
  });

  it("keeps a dead key at a quarter of the median or more, and drops one below it", () => {
    const est = (costs) => estimateKeyLifespans(costs.map((_, i) => dead(`d${i}`)),
      Object.fromEntries(costs.map((cost, i) => [`d${i}`, { cost }])), { now: NOW }).estimate;
    // $125 is exactly a quarter of the $500 median.
    expect(est([125, 500, 500, 600])).toMatchObject({ sampleSize: 4, excluded: 0, median: 500 });
    // Median $500: $120 (24%) goes, $140 (28%) stays.
    expect(est([120, 140, 500, 550, 600])).toMatchObject({ sampleSize: 4, excluded: 1, median: 525 });
  });

  it("gives no estimate when the dead keys consumed nothing", () => {
    const usage = { a: { cost: 0, tokens: 0 }, b: {}, c: {} };
    expect(estimateKeyLifespans([dead("a"), dead("b"), dead("c"), live("k")], usage, { now: NOW }).estimate).toBeNull();
  });

  it("gives no estimate when the median in tokens is zero", () => {
    // Priced keys that report no tokens, plus one unpriced key: the unit is
    // tokens and two of the three consumed none.
    const usage = { a: { cost: 5, tokens: 0 }, b: { cost: 5, tokens: 0 }, c: { cost: 0, tokens: 100 }, k: { cost: 1, tokens: 10 } };
    expect(estimateKeyLifespans([dead("a"), dead("b"), dead("c"), live("k")], usage, { now: NOW })).toEqual({ estimate: null, keys: {} });
  });

  it("gives no estimate for an active key whose usage has no cost when the unit is cost", () => {
    const { connections, usage } = snowflake({ cost: 0, tokens: 5e6, recentCost: 0, recentTokens: 1e5 });
    const { estimate, keys } = estimateKeyLifespans([...connections, live("fresh")], usage, { now: NOW });
    expect(estimate.metric).toBe("cost");
    expect(keys).not.toHaveProperty("k");
    // A key that hasn't served anything yet still starts at 100% left.
    expect(keys.fresh).toMatchObject({ used: 0, percentLeft: 100 });
  });

  it("ignores dead keys that never served anything", () => {
    // Without them dropped first: tokens as the unit (no cost on the empty
    // keys), and a median of 0 with three of five dead on arrival.
    const usage = { a: { cost: 400, tokens: 4e5 }, b: { cost: 500, tokens: 5e5 }, c: { cost: 600, tokens: 6e5 }, k: { cost: 100, tokens: 1e5 } };
    const connections = [dead("a"), dead("b"), dead("c"), dead("doa1"), dead("doa2"), dead("doa3"), live("k")];
    const { estimate, keys } = estimateKeyLifespans(connections, { ...usage, doa1: { cost: 0, tokens: 0 } }, { now: NOW });
    expect(estimate).toEqual({ metric: "cost", median: 500, low: 450, high: 550, sampleSize: 3, excluded: 0 });
    expect(keys.k.used).toBe(100);
  });

  it("projects an ETA from the key's recent burn rate", () => {
    // $36 over the 6h window, key in use for longer than that: $6/h.
    const { keys } = estimateKeyLifespans(...Object.values(snowflake({ cost: 230, recentCost: 36, firstAt: iso(NOW - 30 * HOUR) })), { now: NOW });
    expect(keys.k.ratePerHour).toBeCloseTo(6);
    expect(keys.k.etaHours).toBeCloseTo(322 / 6);
  });

  it("measures the rate from the key's first use when that is inside the window", () => {
    const { keys } = estimateKeyLifespans(...Object.values(snowflake({ cost: 20, recentCost: 20, firstAt: iso(NOW - 2 * HOUR) })), { now: NOW });
    expect(keys.k.ratePerHour).toBeCloseTo(10);
  });

  it("measures the rate over at least 15 minutes for a key that just started", () => {
    // $1 in its first minute: $4/h, not $60/h.
    const { keys } = estimateKeyLifespans(...Object.values(snowflake({ cost: 1, recentCost: 1, firstAt: iso(NOW - 60 * 1000) })), { now: NOW });
    expect(keys.k.ratePerHour).toBeCloseTo(4);
    // Past the floor, the real span counts.
    const later = estimateKeyLifespans(...Object.values(snowflake({ cost: 1, recentCost: 1, firstAt: iso(NOW - 30 * 60 * 1000) })), { now: NOW });
    expect(later.keys.k.ratePerHour).toBeCloseTo(2);
  });

  it("has no ETA for an idle key", () => {
    const { keys } = estimateKeyLifespans(...Object.values(snowflake()), { now: NOW });
    expect(keys.k.ratePerHour).toBeNull();
    expect(keys.k.etaHours).toBeNull();
  });

  it("estimates a key with no usage yet at 100% left", () => {
    const { connections, usage } = snowflake();
    delete usage.k;
    const { keys } = estimateKeyLifespans(connections, usage, { now: NOW });
    expect(keys.k).toMatchObject({ used: 0, percentLeft: 100, remaining: 552, etaHours: null });
  });
});

describe("lifespan label", () => {
  it("reads percent left and time at the current pace", () => {
    const { keys } = estimateKeyLifespans(...Object.values(snowflake({ cost: 230, recentCost: 36 * 6, firstAt: iso(NOW - 30 * HOUR) })), { now: NOW });
    // $36/h, $322 left: ~9h.
    const label = lifespanLabel({ lifespan: keys.k });
    expect(label.text).toBe("~58% left · ~9h at current pace");
    expect(label.title).toBe("Used $230 of a typical $552 (earlier keys lasted $454–$646).\nBased on 9 earlier keys turned off automatically, ignoring 1 that died early.");
  });

  it("says there's no time estimate for an idle key", () => {
    const { keys } = estimateKeyLifespans(...Object.values(snowflake()), { now: NOW });
    expect(lifespanLabel({ lifespan: keys.k }).text).toBe("~58% left");
    expect(lifespanLabel({ lifespan: keys.k }).title).toMatch(/No recent traffic, so no time estimate\.$/);
  });

  it("flags a key past the typical budget", () => {
    const { keys } = estimateKeyLifespans(...Object.values(snowflake({ cost: 600, recentCost: 10 })), { now: NOW });
    expect(lifespanLabel({ lifespan: keys.k }).text).toBe("Past typical lifespan");
  });

  it("reads <1% left rather than ~0% while some budget remains", () => {
    const { keys } = estimateKeyLifespans(...Object.values(snowflake({ cost: 550, recentCost: 6, firstAt: iso(NOW - 30 * HOUR) })), { now: NOW });
    expect(lifespanLabel({ lifespan: keys.k }).text).toBe("<1% left · ~2h at current pace");
    const almost = estimateKeyLifespans(...Object.values(snowflake({ cost: 548, firstAt: iso(NOW - 30 * HOUR) })), { now: NOW });
    expect(lifespanLabel({ lifespan: almost.keys.k }).text).toBe("~1% left");
    // 0.47% left still rounds to 0, so it reads <1% too.
    const edge = estimateKeyLifespans(...Object.values(snowflake({ cost: 549.4, firstAt: iso(NOW - 30 * HOUR) })), { now: NOW });
    expect(edge.keys.k.percentLeft).toBeCloseTo(0.47, 2);
    expect(lifespanLabel({ lifespan: edge.keys.k }).text).toBe("<1% left");
  });

  it("formats tokens and long durations", () => {
    const label = lifespanLabel({ lifespan: { metric: "tokens", used: 2.5e6, budget: 1e7, low: 8e6, high: 1.2e7, percentLeft: 75, remaining: 7.5e6, etaHours: 72, sampleSize: 3, excluded: 0 } });
    expect(label.text).toBe("~75% left · ~3d at current pace");
    expect(label.title).toBe("Used 2.5M tokens of a typical 10M tokens (earlier keys lasted 8.0M tokens–12M tokens).\nBased on 3 earlier keys turned off automatically.");
  });

  it("formats amounts like the account page does", () => {
    const at = (metric, used) => lifespanLabel({ lifespan: { metric, used, budget: 1e9, low: 1e9, high: 1e9, percentLeft: 50, remaining: 1, etaHours: 1, sampleSize: 3, excluded: 0 } })
      .title.match(/^Used (.*) of a typical/)[1];
    expect(at("tokens", 2500)).toBe("2.5K tokens");
    expect(at("tokens", 19_600)).toBe("20K tokens");
    expect(at("cost", 12.4)).toBe("$12");
    expect(at("cost", 3.61)).toBe("$3.61");
    // An embeddings key's first requests cost fractions of a cent.
    expect(at("cost", 0.004)).toBe("$0.004");
    expect(at("cost", 0.000123)).toBe("$0.00012");
    expect(at("cost", 0)).toBe("$0");
  });

  it("formats short and day-and-a-half ETAs", () => {
    const eta = (etaHours) => lifespanLabel({ lifespan: { metric: "cost", used: 1, budget: 10, low: 9, high: 11, percentLeft: 90, remaining: 9, etaHours, sampleSize: 3, excluded: 0 } }).text;
    expect(eta(30)).toBe("~90% left · ~30h at current pace");
    expect(eta(0.25)).toBe("~90% left · ~15m at current pace");
    expect(eta(5 / 3600)).toBe("~90% left · ~1m at current pace");
  });

  it("gives a key past the typical budget no time-estimate note", () => {
    const { keys } = estimateKeyLifespans(...Object.values(snowflake({ cost: 600 })), { now: NOW });
    expect(keys.k.etaHours).toBeNull();
    expect(lifespanLabel({ lifespan: keys.k }).title).not.toMatch(/No recent traffic/);
  });

  it("shows nothing without an estimate or for a key that is off", () => {
    expect(lifespanLabel(null)).toBeNull();
    expect(lifespanLabel({ id: "k", isActive: true, lifespan: null })).toBeNull();
    const { keys } = estimateKeyLifespans(...Object.values(snowflake()), { now: NOW });
    const row = withLifespans([{ id: "k", isActive: true }, { id: "other", isActive: true }], keys);
    expect(lifespanLabel(row[0]).text).toBe("~58% left");
    expect(lifespanLabel(row[1])).toBeNull();
    expect(lifespanLabel({ isActive: true, lifespan: { ...keys.k, budget: 0 } })).toBeNull();
    expect(lifespanLabel(withToggledActive(row[0], false, { id: "k", isActive: false }))).toBeNull();
  });
});

// ---- repo, against a real temp SQLite DB --------------------------------
const originalDataDir = process.env.DATA_DIR;
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "10router-key-lifespan-"));

describe("getKeyLifespans", () => {
  let db, adapter, repo;
  let seq = 0;
  let provider;

  beforeAll(async () => {
    process.env.DATA_DIR = tempDir;
    vi.resetModules();
    db = await import("@/lib/db/index.js");
    adapter = await (await import("@/lib/db/driver.js")).getAdapter();
    repo = await import("@/lib/db/repos/keyLifespanRepo.js");
  });

  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
  });

  beforeEach(() => {
    provider = `openai-compatible-chat-lifespan-${++seq}`;
    repo.clearKeyLifespanCache();
  });

  async function addKey(name, { deadAt } = {}) {
    const c = await db.createProviderConnection({ provider, authType: "apikey", name, apiKey: `sk-test-${name}-0123456789` });
    if (deadAt) await db.updateProviderConnection(c.id, { isActive: false, autoDisabledAt: deadAt, autoDisabledReason: "403" });
    return c.id;
  }

  function record(connectionId, { at, cost = 0, prompt = 0, completion = 0, status = "ok" }) {
    adapter.run(
      `INSERT INTO usageHistory(timestamp, provider, model, connectionId, promptTokens, completionTokens, cost, status) VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
      [iso(at), provider, "m", connectionId, prompt, completion, cost, status]
    );
  }

  it("sums only successful usage per key and estimates the active ones", async () => {
    const deadIds = [];
    for (const [i, cost] of [400, 500, 600].entries()) {
      const id = await addKey(`dead${i}`, { deadAt: iso(NOW - 24 * HOUR) });
      deadIds.push(id);
      record(id, { at: NOW - 40 * HOUR, cost: cost / 2, prompt: 100, completion: 10 });
      record(id, { at: NOW - 30 * HOUR, cost: cost / 2, prompt: 100, completion: 10 });
      record(id, { at: NOW - 25 * HOUR, cost: 999, status: "error" });
    }
    const early = await addKey("locked", { deadAt: iso(NOW - 20 * HOUR) });
    record(early, { at: NOW - 21 * HOUR, cost: 20 });
    const k = await addKey("live");
    record(k, { at: NOW - 20 * HOUR, cost: 100 });
    record(k, { at: NOW - 2 * HOUR, cost: 30 });
    record(k, { at: NOW - 1 * HOUR, cost: 20 });
    record(k, { at: NOW - 1 * HOUR, cost: 500, status: "error" });
    const idle = await addKey("idle");

    const usage = await repo.getKeyWindowUsage([...deadIds, k].map((id) => ({ id })), iso(NOW - 6 * HOUR));
    expect(usage[deadIds[0]]).toEqual({ cost: 400, tokens: 220, firstAt: iso(NOW - 40 * HOUR), recentCost: 0, recentTokens: 0 });
    expect(usage[k]).toMatchObject({ cost: 150, recentCost: 50 });

    const result = await repo.getKeyLifespans(provider, { now: NOW });
    expect(result.estimate).toEqual({ metric: "cost", median: 500, low: 450, high: 550, sampleSize: 3, excluded: 1 });
    expect(Object.keys(result.keys).sort()).toEqual([k, idle].sort());
    expect(result.keys[k]).toMatchObject({ used: 150, remaining: 350, percentLeft: 70 });
    expect(result.keys[k].ratePerHour).toBeCloseTo(50 / 6);
    expect(result.keys[idle]).toMatchObject({ used: 0, etaHours: null });
  });

  it("counts what the usage writer stores for chat (no status) and embeddings/systemone (\"success\"), not failures", async () => {
    const usageRepo = await import("@/lib/db/repos/usageRepo.js");
    // As requestDetail.js (chat), embeddings.js / systemone.js, and a failure.
    const write = (connectionId, at, tokens, status) => usageRepo.saveRequestUsage({
      provider, model: "lifespan-unpriced-model", connectionId, timestamp: iso(at),
      tokens: { prompt_tokens: tokens, completion_tokens: 0 }, ...(status ? { status } : {}),
    });
    for (const i of [1, 2, 3]) {
      const id = await addKey(`dead${i}`, { deadAt: iso(NOW - HOUR) });
      await write(id, NOW - 10 * HOUR, 1000 * i);
      await write(id, NOW - 9 * HOUR, 1000 * i, "success");
      await write(id, NOW - 8 * HOUR, 99999, "error");
    }
    const k = await addKey("live");
    await write(k, NOW - 2 * HOUR, 500, "success");
    await write(k, NOW - 2 * HOUR, 500);
    const { estimate, keys } = await repo.getKeyLifespans(provider, { now: NOW });
    expect(estimate).toMatchObject({ metric: "tokens", median: 4000, low: 3000, high: 5000, sampleSize: 3 });
    expect(keys[k].used).toBe(1000);
  });

  describe("a new key on an existing connection", () => {
    afterEach(() => vi.useRealTimers());

    async function withDeadPeers() {
      for (const i of [1, 2, 3]) record(await addKey(`peer${i}`, { deadAt: iso(NOW - 30 * HOUR) }), { at: NOW - 40 * HOUR, cost: 500 });
    }
    const at = (ms) => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(ms)); };

    it("starts from zero when a new key is pasted into a dead connection", async () => {
      await withDeadPeers();
      const x = await addKey("reused", { deadAt: iso(NOW - 8 * HOUR) });
      record(x, { at: NOW - 10 * HOUR, cost: 450 });
      at(NOW - 5 * HOUR);
      await db.updateProviderConnection(x, { apiKey: "sk-test-reused-NEW-0123456789" });
      const conn = await db.getProviderConnectionById(x);
      expect(conn).toMatchObject({ isActive: true, keySetAt: iso(NOW - 5 * HOUR) });
      // Saving the same key again keeps the stamp.
      at(NOW - 4.5 * HOUR);
      await db.updateProviderConnection(x, { apiKey: "sk-test-reused-NEW-0123456789" });
      expect((await db.getProviderConnectionById(x)).keySetAt).toBe(iso(NOW - 5 * HOUR));
      record(x, { at: NOW - 4 * HOUR, cost: 50 });
      vi.useRealTimers();

      expect((await repo.getKeyLifespans(provider, { now: NOW })).keys[x].used).toBe(50);
      // Dead again, each key counts its own spend: the old key's $450 is a
      // sample of its own, and the new key's $50 an early death.
      await db.updateProviderConnection(x, { isActive: false, autoDisabledAt: iso(NOW - HOUR), autoDisabledReason: "403" });
      expect((await repo.getKeyLifespans(provider, { now: NOW })).estimate).toMatchObject({ median: 500, sampleSize: 4, excluded: 1 });
    });

    it("keeps each key that died before being replaced in place as a dead key", async () => {
      const x = await addKey("rotated");
      for (const [i, cost] of [400, 500, 600].entries()) {
        const t = NOW - (30 - 10 * i) * HOUR;
        record(x, { at: t, cost });
        await db.updateProviderConnection(x, { isActive: false, autoDisabledAt: iso(t + HOUR), autoDisabledReason: "403" });
        at(t + 2 * HOUR);
        await db.updateProviderConnection(x, { apiKey: `sk-test-rotated-${i}-0123456789` });
        vi.useRealTimers();
      }
      record(x, { at: NOW - 5 * HOUR, cost: 100 });
      const conn = await db.getProviderConnectionById(x);
      expect(conn.pastKeys).toEqual([
        { since: "", until: iso(NOW - 29 * HOUR) },
        { since: iso(NOW - 28 * HOUR), until: iso(NOW - 19 * HOUR) },
        { since: iso(NOW - 18 * HOUR), until: iso(NOW - 9 * HOUR) },
      ]);
      const { estimate, keys } = await repo.getKeyLifespans(provider, { now: NOW });
      expect(estimate).toEqual({ metric: "cost", median: 500, low: 450, high: 550, sampleSize: 3, excluded: 0 });
      expect(Object.keys(keys)).toEqual([x]);
      expect(keys[x]).toMatchObject({ used: 100, remaining: 400 });
    });

    it("adds no dead key when the key of a working connection is replaced", async () => {
      await withDeadPeers();
      const x = await addKey("working");
      record(x, { at: NOW - 10 * HOUR, cost: 300 });
      at(NOW - 5 * HOUR);
      await db.updateProviderConnection(x, { apiKey: "sk-test-working-NEW-0123456789" });
      vi.useRealTimers();
      expect((await db.getProviderConnectionById(x)).pastKeys).toBeUndefined();
      expect((await repo.getKeyLifespans(provider, { now: NOW })).estimate.sampleSize).toBe(3);
    });

    it("adds no dead key when a dead connection is edited or turned back on without a new key", async () => {
      const ids = [];
      for (const [i, cost] of [100, 500, 900].entries()) {
        const id = await addKey(`d${i}`, { deadAt: iso(NOW - 10 * HOUR) });
        record(id, { at: NOW - 20 * HOUR, cost });
        ids.push(id);
      }
      await db.updateProviderConnection(ids[0], { name: "renamed", priority: 7 });
      await db.updateProviderConnection(ids[0], { lastError: "401", apiKey: "sk-test-d0-0123456789" });
      await db.updateProviderConnection(ids[1], { isActive: true });
      for (const id of ids) expect((await db.getProviderConnectionById(id)).pastKeys).toBeUndefined();
      expect((await repo.getKeyLifespans(provider, { now: NOW })).estimate).toBeNull();
    });

    // A dead key the router left on: soft-demoted on two models, as auth.js
    // writes it, at `since`, last refused for itself at `lastMs`.
    const softRecord = (sinceMs, lastMs, extra) => ({
      level: 2, since: iso(sinceMs), tryAt: iso(lastMs + HOUR), lastRefusedAt: iso(lastMs), keyRefused: true,
      tries: 2, triesFrom: iso(sinceMs), keyRefusedAt: iso(lastMs), ...extra,
    });
    const soft = (sinceMs, lastMs, extra = {}) => ({
      [`${SOFT_DEMOTE_PREFIX}m`]: softRecord(sinceMs, lastMs, extra),
      [`${SOFT_DEMOTE_PREFIX}m2`]: softRecord(sinceMs, lastMs, extra),
      authDemoteOkAt: iso(sinceMs),
    });
    const refusedAt = (id, ms) => db.updateProviderConnection(id, soft(ms - HOUR, ms));

    it("keeps a soft-demoted key that served nothing since as a dead key when it is replaced", async () => {
      await withDeadPeers();
      const x = await addKey("left-on");
      record(x, { at: NOW - 10 * HOUR, cost: 450 });
      await refusedAt(x, NOW - 9 * HOUR);
      at(NOW - 5 * HOUR);
      await db.updateProviderConnection(x, { apiKey: "sk-test-left-on-NEW-0123456789" });
      vi.useRealTimers();
      expect((await db.getProviderConnectionById(x)).pastKeys).toEqual([{ since: "", until: iso(NOW - 9 * HOUR) }]);
      expect((await repo.getKeyLifespans(provider, { now: NOW })).estimate).toMatchObject({ sampleSize: 4 });
    });

    // Its soft demotion on a second model wrote authDemoteOkAt; that isn't a success.
    it("keeps it as a dead key when it was soft-demoted on a second model since", async () => {
      await withDeadPeers();
      const x = await addKey("left-on-two");
      record(x, { at: NOW - 10 * HOUR, cost: 450 });
      await db.updateProviderConnection(x, { ...soft(NOW - 10 * HOUR, NOW - 9 * HOUR), authDemoteOkAt: iso(NOW - 9.5 * HOUR) });
      at(NOW - 5 * HOUR);
      await db.updateProviderConnection(x, { apiKey: "sk-test-left-on-two-NEW-0123456789" });
      vi.useRealTimers();
      expect((await db.getProviderConnectionById(x)).pastKeys).toEqual([{ since: "", until: iso(NOW - 9 * HOUR) }]);
    });

    // Served after its soft demotion began, then refused for itself again; and
    // a later try refused for just that model, which isn't a refusal of the key.
    it("counts it as dead from its last refusal of the key itself after a success", async () => {
      await withDeadPeers();
      const x = await addKey("left-on-again");
      record(x, { at: NOW - 10 * HOUR, cost: 450 });
      await db.updateProviderConnection(x, {
        ...soft(NOW - 10 * HOUR, NOW - 8 * HOUR, { lastRefusedAt: iso(NOW - 7 * HOUR) }), authServedAt: iso(NOW - 9 * HOUR),
      });
      at(NOW - 5 * HOUR);
      await db.updateProviderConnection(x, { apiKey: "sk-test-left-on-again-NEW-0123456789" });
      vi.useRealTimers();
      expect((await db.getProviderConnectionById(x)).pastKeys).toEqual([{ since: "", until: iso(NOW - 8 * HOUR) }]);
    });

    it.each([
      ["on one model, with 401s in a row", { [`${SOFT_DEMOTE_PREFIX}m`]: softRecord(NOW - 10 * HOUR, NOW - 8 * HOUR), authHeld401s: 5 }],
      // Records from before keyRefusedAt was kept: their last refusal, with refused tries.
      ["on two models, its records without keyRefusedAt", Object.fromEntries(["m", "m2"].map((m) => [`${SOFT_DEMOTE_PREFIX}${m}`,
        { ...softRecord(NOW - 10 * HOUR, NOW - 8 * HOUR), keyRefusedAt: undefined }])),
      ],
    ])("counts a key refused for itself %s since it last served as dead", async (_label, state) => {
      await withDeadPeers();
      const x = await addKey("left-on-401");
      record(x, { at: NOW - 10 * HOUR, cost: 450 });
      await db.updateProviderConnection(x, { ...state, authServedAt: iso(NOW - 9 * HOUR) });
      at(NOW - 5 * HOUR);
      await db.updateProviderConnection(x, { apiKey: "sk-test-left-on-401-NEW-0123456789" });
      vi.useRealTimers();
      expect((await db.getProviderConnectionById(x)).pastKeys).toEqual([{ since: "", until: iso(NOW - 8 * HOUR) }]);
    });

    // It may be a good key someone switched off and on to retry it.
    it("adds no dead key when such a key is switched off and on by hand", async () => {
      await withDeadPeers();
      const x = await addKey("switched-off");
      record(x, { at: NOW - 10 * HOUR, cost: 450 });
      await refusedAt(x, NOW - 9 * HOUR);
      await db.updateProviderConnection(x, { isActive: false });
      await db.updateProviderConnection(x, { isActive: true });
      expect((await db.getProviderConnectionById(x)).pastKeys).toBeUndefined();
      expect((await repo.getKeyLifespans(provider, { now: NOW })).estimate).toMatchObject({ sampleSize: 3 });
    });

    it.each([
      ["was last refused, with no soft demotion (an outage, say)", { errorCode: 403, testStatus: "unavailable", lastErrorAt: iso(NOW - 9 * HOUR) }],
      ["is soft-demoted for refusals of one model only", soft(NOW - 12 * HOUR, NOW - 9 * HOUR, { keyRefused: false })],
      ["served after it was last refused for itself", { ...soft(NOW - 12 * HOUR, NOW - 9 * HOUR), authServedAt: iso(NOW - 8 * HOUR) }],
      // As the turn-off rule, which needs two models (or 401s in a row).
      ["was refused for itself on one model only since it last served", {
        [`${SOFT_DEMOTE_PREFIX}m`]: softRecord(NOW - 12 * HOUR, NOW - 9 * HOUR), authServedAt: iso(NOW - 10 * HOUR),
      }],
    ])("adds no dead key when a key that %s is replaced or switched off by hand", async (_label, state) => {
      const x = await addKey("fine");
      const y = await addKey("fine-too");
      at(NOW - 10 * HOUR);
      for (const id of [x, y]) await db.updateProviderConnection(id, { keySetAt: iso(NOW - 20 * HOUR), ...state });
      await db.updateProviderConnection(x, { apiKey: "sk-test-fine-NEW-0123456789" });
      await db.updateProviderConnection(y, { isActive: false });
      vi.useRealTimers();
      for (const id of [x, y]) expect((await db.getProviderConnectionById(id)).pastKeys).toBeUndefined();
    });

    it("keeps only the last 50 replaced keys", async () => {
      const x = await addKey("many");
      for (let i = 0; i < 55; i++) {
        await db.updateProviderConnection(x, { isActive: false, autoDisabledAt: iso(NOW - (60 - i) * HOUR), autoDisabledReason: "403" });
        await db.updateProviderConnection(x, { apiKey: `sk-test-many-${i}-0123456789` });
      }
      const { pastKeys } = await db.getProviderConnectionById(x);
      expect(pastKeys).toHaveLength(50);
      expect(pastKeys.at(-1).until).toBe(iso(NOW - 6 * HOUR));
    });

    it("starts from zero when a key is re-added under the same name", async () => {
      await withDeadPeers();
      const x = await addKey("same-name");
      record(x, { at: NOW - 10 * HOUR, cost: 300 });
      at(NOW - 5 * HOUR);
      const again = await db.createProviderConnection({ provider, authType: "apikey", name: "same-name", apiKey: "sk-test-same-name-NEW-0123456789" });
      expect(again.id).toBe(x);
      record(x, { at: NOW - 4 * HOUR, cost: 20 });
      vi.useRealTimers();
      expect((await repo.getKeyLifespans(provider, { now: NOW })).keys[x].used).toBe(20);
    });
  });

  it("returns only ids and numbers, never credentials", async () => {
    for (const i of [1, 2, 3]) record(await addKey(`dead${i}`, { deadAt: iso(NOW - HOUR) }), { at: NOW - 2 * HOUR, cost: 100 });
    await addKey("live");
    const json = JSON.stringify(await repo.getKeyLifespans(provider, { now: NOW }));
    expect(json).not.toMatch(/sk-test|apiKey|accessToken|refreshToken|name/);
  });

  it("gives no estimate for a provider with fewer than 3 dead keys", async () => {
    record(await addKey("dead", { deadAt: iso(NOW - HOUR) }), { at: NOW - 2 * HOUR, cost: 100 });
    await addKey("live");
    expect(await repo.getKeyLifespans(provider, { now: NOW })).toEqual({ estimate: null, keys: {} });
  });

  it("gives OAuth and cookie accounts no estimate and doesn't count them as dead keys", async () => {
    for (const [i, cost] of [40, 45, 50].entries()) record(await addKey(`dead${i}`, { deadAt: iso(NOW - HOUR) }), { at: NOW - 2 * HOUR, cost });
    const k = await addKey("live");
    const account = async (authType, name, extra = {}) => {
      const c = await db.createProviderConnection({ provider, authType, name, email: `${name}@example.com`, accessToken: `tok-${name}`, ...extra });
      record(c.id, { at: NOW - 3 * HOUR, cost: 30 });
      return c.id;
    };
    const oauth = await account("oauth", "sub");
    const cookie = await account("cookie", "web");
    // Even marked as turned off automatically, they aren't samples: three of
    // them at $500 would move the median.
    for (const i of [1, 2, 3]) {
      const id = await account("oauth", `gone${i}`);
      record(id, { at: NOW - 3 * HOUR, cost: 470 });
      await db.updateProviderConnection(id, { isActive: false, autoDisabledAt: iso(NOW - HOUR), autoDisabledReason: "401" });
    }
    const { estimate, keys } = await repo.getKeyLifespans(provider, { now: NOW });
    expect(estimate).toMatchObject({ median: 45, sampleSize: 3 });
    expect(Object.keys(keys)).toEqual([k]);
    expect(keys).not.toHaveProperty(oauth);
    expect(keys).not.toHaveProperty(cookie);
  });

  it("caches briefly and refreshes when the provider's connections change", async () => {
    const ids = [];
    for (const i of [1, 2, 3]) {
      const id = await addKey(`dead${i}`, { deadAt: iso(NOW - HOUR) });
      ids.push(id);
      record(id, { at: NOW - 2 * HOUR, cost: 100 });
    }
    const k = await addKey("live");
    const first = await repo.getKeyLifespans(provider, { now: NOW });
    record(k, { at: NOW - 60 * 1000, cost: 10 });
    expect(await repo.getKeyLifespans(provider, { now: NOW + 1000 })).toBe(first);
    expect((await repo.getKeyLifespans(provider, { now: NOW + 61 * 1000 })).keys[k].used).toBe(10);
    await db.updateProviderConnection(k, { isActive: false, autoDisabledAt: iso(NOW), autoDisabledReason: "403" });
    expect((await repo.getKeyLifespans(provider, { now: NOW + 62 * 1000 })).keys).toEqual({});
  });

  it("counts a row's tokens when one of its token columns is NULL", async () => {
    const id = `${provider}-null-tokens`;
    const insert = (at, prompt, completion) => adapter.run(
      `INSERT INTO usageHistory(timestamp, provider, model, connectionId, promptTokens, completionTokens, cost, status) VALUES(?, ?, 'm', ?, ?, ?, 0, 'ok')`,
      [iso(at), provider, id, prompt, completion]
    );
    insert(NOW - HOUR, 100, null);
    insert(NOW - 2 * HOUR, null, 30);
    insert(NOW - 10 * HOUR, null, null);
    const usage = await repo.getKeyWindowUsage([{ id }], iso(NOW - 6 * HOUR));
    expect(usage[id]).toMatchObject({ tokens: 130, recentTokens: 130 });
    const none = `${provider}-no-completion`;
    adapter.run(`INSERT INTO usageHistory(timestamp, provider, model, connectionId, promptTokens, completionTokens, cost, status) VALUES(?, ?, 'm', ?, 50, NULL, 0, 'ok')`, [iso(NOW - HOUR), provider, none]);
    expect((await repo.getKeyWindowUsage([{ id: none }], iso(NOW - 6 * HOUR)))[none]).toMatchObject({ tokens: 50, recentTokens: 50 });
  });

  it("refreshes at once when an active connection gets a new key", async () => {
    for (const i of [1, 2, 3]) record(await addKey(`dead${i}`, { deadAt: iso(NOW - 30 * HOUR) }), { at: NOW - 40 * HOUR, cost: 100 });
    const k = await addKey("live");
    record(k, { at: NOW - 20 * HOUR, cost: 60 });
    expect((await repo.getKeyLifespans(provider, { now: NOW })).keys[k].used).toBe(60);
    const before = db.connectionsVersion();
    await db.updateProviderConnection(k, { apiKey: "sk-test-live-NEW-0123456789" });
    expect(db.connectionsVersion()).toBeGreaterThan(before);
    expect((await repo.getKeyLifespans(provider, { now: NOW + 1000 })).keys[k].used).toBe(0);
    // A write that changes nothing the estimate reads leaves the cache alone.
    const v = db.connectionsVersion();
    await db.updateProviderConnection(k, { lastError: "x", accessToken: "refreshed", rateLimitedUntil: iso(NOW + HOUR) });
    expect(db.connectionsVersion()).toBe(v);
  });

  it("reads providers with more keys than one query's chunk", async () => {
    const ids = Array.from({ length: 950 }, (_, i) => `${provider}-bulk-${i}`);
    record(ids[3], { at: NOW - HOUR, cost: 1 });
    record(ids[420], { at: NOW - 2 * HOUR, cost: 2, prompt: 10 });
    record(ids[420], { at: NOW - 10 * HOUR, cost: 3 });
    record(ids[949], { at: NOW - HOUR, cost: 4 });
    const all = vi.spyOn(adapter, "all");
    const usage = await repo.getKeyWindowUsage(ids.map((id) => ({ id })), iso(NOW - 6 * HOUR));
    const calls = all.mock.calls.filter(([sql]) => sql.startsWith("WITH w("));
    all.mockRestore();
    expect(calls.length).toBeGreaterThan(1);
    expect(calls).toHaveLength(Math.ceil(950 / repo.WINDOW_CHUNK));
    for (const [, params] of calls) expect(params.length).toBeLessThanOrEqual(802);
    expect(Object.keys(usage).sort()).toEqual([ids[3], ids[420], ids[949]].sort());
    expect(usage[ids[420]]).toEqual({ cost: 5, tokens: 10, firstAt: iso(NOW - 10 * HOUR), recentCost: 2, recentTokens: 10 });
    expect(usage[ids[949]].cost).toBe(4);
  });

  describe("dead keys whose usage can no longer change", () => {
    const windowQueries = async (now) => {
      const all = vi.spyOn(adapter, "all");
      const result = await repo.getKeyLifespans(provider, { now });
      const windows = all.mock.calls.filter(([sql]) => sql.startsWith("WITH w(")).flatMap(([, params]) => {
        const out = [];
        for (let i = 0; i + 4 <= params.length - 2; i += 4) out.push(params[i]);
        return out;
      });
      all.mockRestore();
      return { result, windows };
    };

    it("reads them once, then only the live keys and keys that died minutes ago", async () => {
      const ids = [];
      for (const i of [1, 2, 3]) {
        const id = await addKey(`dead${i}`, { deadAt: iso(NOW - 2 * HOUR) });
        record(id, { at: NOW - 3 * HOUR, cost: 100 });
        ids.push(id);
      }
      const rotated = await addKey("rotated", { deadAt: iso(NOW - 5 * HOUR) });
      record(rotated, { at: NOW - 6 * HOUR, cost: 110 });
      await db.updateProviderConnection(rotated, { apiKey: "sk-test-rotated-NEW-0123456789" });
      const fresh = await addKey("fresh", { deadAt: iso(NOW - 60 * 1000) });
      record(fresh, { at: NOW - 2 * 60 * 1000, cost: 90 });
      const k = await addKey("live");
      record(k, { at: NOW - HOUR, cost: 20 });
      await addKey("off-by-hand").then((id) => db.updateProviderConnection(id, { isActive: false }));

      const first = await windowQueries(NOW);
      expect(first.windows).toHaveLength(7);
      expect(first.result.estimate).toMatchObject({ median: 100, sampleSize: 5 });

      // An in-flight request on the key that just died lands late; so does one
      // on a long-dead key, which the estimate has already settled.
      record(fresh, { at: NOW - 30 * 1000, cost: 40 });
      record(ids[0], { at: NOW - 3 * HOUR, cost: 1000 });
      record(k, { at: NOW - 60 * 1000, cost: 5 });
      const second = await windowQueries(NOW + 61 * 1000);
      expect(second.windows.sort()).toEqual([fresh, k, rotated].sort());
      expect(second.result.estimate).toMatchObject({ median: 100, high: 110, sampleSize: 5 });
      expect(second.result.keys[k].used).toBe(25);

      // Ten minutes after it died, the last key is read one final time, then
      // never again.
      const third = await windowQueries(NOW + 11 * 60 * 1000);
      expect(third.windows.sort()).toEqual([fresh, k, rotated].sort());
      const fourth = await windowQueries(NOW + 13 * 60 * 1000);
      expect(fourth.windows.sort()).toEqual([k, rotated].sort());
      expect(fourth.result.estimate).toEqual(second.result.estimate);
    });

    it("doesn't read the live keys while the dead keys give no estimate", async () => {
      const dead = [];
      for (const [i, cost] of [100, 0].entries()) {
        const id = await addKey(`dead${i}`, { deadAt: iso(NOW - 2 * HOUR) });
        if (cost) record(id, { at: NOW - 3 * HOUR, cost });
        dead.push(id);
      }
      const k = await addKey("live");
      for (let i = 0; i < 20; i++) record(k, { at: NOW - i * 60 * 1000, cost: 5 });

      const first = await windowQueries(NOW);
      expect(first.windows.sort()).toEqual([...dead].sort());
      expect(first.result).toEqual({ estimate: null, keys: {} });
      // Both are settled, the one that served nothing too: not read again.
      expect((await windowQueries(NOW + 61 * 1000)).windows).toEqual([]);

      // A third dead key that served something makes an estimate possible.
      const third = await addKey("dead2", { deadAt: iso(NOW - HOUR) });
      record(third, { at: NOW - 2 * HOUR, cost: 100 });
      const withDeadZero = await windowQueries(NOW);
      expect(withDeadZero.windows).not.toContain(k);
      expect(withDeadZero.result.estimate).toBeNull();

      const fourth = await addKey("dead3", { deadAt: iso(NOW - HOUR) });
      record(fourth, { at: NOW - 2 * HOUR, cost: 100 });
      const ready = await windowQueries(NOW);
      expect(ready.windows).toContain(k);
      expect(ready.result.keys[k].used).toBe(100);
    });

    it("reads a key afresh when it dies again after being turned back on", async () => {
      const ids = [];
      for (const i of [1, 2, 3]) {
        const id = await addKey(`dead${i}`, { deadAt: iso(NOW - 5 * HOUR) });
        record(id, { at: NOW - 6 * HOUR, cost: 100 });
        ids.push(id);
      }
      expect((await repo.getKeyLifespans(provider, { now: NOW })).estimate).toMatchObject({ median: 100 });
      await db.updateProviderConnection(ids[0], { isActive: true });
      record(ids[0], { at: NOW - 4 * HOUR, cost: 300 });
      await db.updateProviderConnection(ids[0], { isActive: false, autoDisabledAt: iso(NOW - 3 * HOUR), autoDisabledReason: "403" });
      expect((await repo.getKeyLifespans(provider, { now: NOW })).estimate).toMatchObject({ median: 100, high: 250, sampleSize: 3 });
    });

    it("keeps the memo over the cap when a refresh has nothing new to store", async () => {
      for (const i of [1, 2, 3]) {
        const id = await addKey(`dead${i}`, { deadAt: iso(NOW - 2 * HOUR) });
        record(id, { at: NOW - 3 * HOUR, cost: 100 });
      }
      expect((await windowQueries(NOW)).windows).toHaveLength(3);
      for (let i = 0; i < repo.CLOSED_CAP; i++) global._keyLifespanClosed.set(`other-${i}`, null);
      expect((await windowQueries(NOW + 61 * 1000)).windows).toEqual([]);
      const third = await windowQueries(NOW + 122 * 1000);
      expect(third.windows).toEqual([]);
      expect(third.result.estimate).toMatchObject({ median: 100 });
    });
  });

  it("clears the settled dead keys' sums when storing new ones would go over the cap", async () => {
    const ids = [];
    for (const i of [1, 2, 3]) {
      const id = await addKey(`dead${i}`, { deadAt: iso(NOW - 2 * HOUR) });
      record(id, { at: NOW - 3 * HOUR, cost: 100 });
      ids.push(id);
    }
    for (let i = 0; i < repo.CLOSED_CAP - 2; i++) global._keyLifespanClosed.set(`stale-${i}`, null);
    expect((await repo.getKeyLifespans(provider, { now: NOW })).estimate).toMatchObject({ median: 100 });
    expect(global._keyLifespanClosed.size).toBe(3);
    expect([...global._keyLifespanClosed.keys()].map((k) => k.split("|")[0]).sort()).toEqual([...ids].sort());
  });

  it("drops expired cache entries when it stores a new one", async () => {
    for (let i = 0; i < 50; i++) await repo.getKeyLifespans(`no-such-provider-${i}`, { now: NOW });
    expect(global._keyLifespanCache.size).toBe(50);
    await repo.getKeyLifespans("no-such-provider-later", { now: NOW + 61 * 1000 });
    expect([...global._keyLifespanCache.keys()]).toEqual(["no-such-provider-later"]);
  });

  it("aggregates from the covering index without reading table rows", () => {
    const plan = adapter.all(`EXPLAIN QUERY PLAN ${repo.keyUsageSql(2)}`, ["a", "a", "", "9999", "b#0", "b", "", iso(NOW), iso(NOW), iso(NOW)]);
    const detail = plan.map((r) => r.detail).join("\n");
    expect(detail).toMatch(/USING COVERING INDEX idx_uh_conn_ok/);
  });
});
