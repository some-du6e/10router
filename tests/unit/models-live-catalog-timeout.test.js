// A provider whose live model catalog never answers must not hold up the model
// list, which the auto-combo catalog waits on right after a restart. Each live
// catalog gets LIVE_CATALOG_TIMEOUT_MS, and they run side by side.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";

const live = vi.hoisted(() => ({ grokSignals: [], zedOptions: [], zed: null }));

vi.mock("open-sse/services/grokCliModels.js", () => ({
  // Never answers, like an upstream that accepted the connection and stalled.
  resolveGrokCliModels: (_credentials, options = {}) => {
    live.grokSignals.push(options.signal);
    return new Promise(() => {});
  },
}));

vi.mock("open-sse/shared/zedAuth.js", () => ({
  // Zed shares one in-flight /models fetch between the list and chat requests.
  resolveZedModels: (_credentials, options) => {
    live.zedOptions.push(options);
    return live.zed;
  },
}));

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "models-live-catalog-"));
const originalDataDir = process.env.DATA_DIR;
process.env.DATA_DIR = tempDir;
delete global._dbAdapter;

const db = await import("@/lib/db/index.js");
const { getAdapter } = await import("@/lib/db/driver.js");
const { buildModelsList, LIVE_CATALOG_TIMEOUT_MS } = await import("@/app/api/v1/models/route.js");

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

beforeAll(async () => {
  await getAdapter();
  for (const provider of ["grok-cli", "zed"]) {
    await db.createProviderConnection({ provider, authType: "oauth", name: provider, accessToken: "t", isActive: true });
  }
});

afterEach(() => {
  vi.useRealTimers();
  live.grokSignals = [];
  live.zedOptions = [];
});

afterAll(() => {
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("model list with live catalogs that never answer", () => {
  it("answers with the static models once LIVE_CATALOG_TIMEOUT_MS passes, for all providers at once", async () => {
    const staticList = await buildModelsList(["llm"], { skipLiveCatalogs: true });
    const shared = deferred();
    live.zed = shared.promise;
    const timedOut = [];
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    let done = false;
    const aliases = [];
    const pending = buildModelsList(["llm"], { onLiveTimeout: (id, { alias }) => { timedOut.push(id); aliases.push(alias); } })
      .then((models) => { done = true; return models; });
    await vi.advanceTimersByTimeAsync(LIVE_CATALOG_TIMEOUT_MS - 100);
    expect(done).toBe(false);
    expect(live.grokSignals).toHaveLength(1);
    expect(live.grokSignals[0].aborted).toBe(false);

    // Both providers hang, yet the list answers after one timeout, not two.
    await vi.advanceTimersByTimeAsync(200);
    const models = await pending;
    expect(models).toEqual(staticList);
    expect(timedOut.sort()).toEqual(["grok-cli", "zed"]);
    // Each with the prefix its ids are listed under, so a caller can keep the
    // models it already held for that provider.
    expect(aliases).toHaveLength(2);
    expect(aliases.every((alias) => typeof alias === "string" && alias.length > 0)).toBe(true);
    // Grok CLI's own fetch is told to stop.
    expect(live.grokSignals[0].aborted).toBe(true);
  });

  it("never aborts Zed's shared /models fetch, so chat requests that joined it still get its answer", async () => {
    const shared = deferred();
    live.zed = shared.promise;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    const pending = buildModelsList(["llm"]);
    await vi.advanceTimersByTimeAsync(LIVE_CATALOG_TIMEOUT_MS + 100);
    await pending;

    expect(live.zedOptions).toHaveLength(1);
    expect(live.zedOptions[0]?.signal).toBeUndefined();
    // A chat request waiting on the same promise is answered when Zed is.
    const answer = { models: [{ id: "zed-model" }] };
    shared.resolve(answer);
    await expect(live.zed).resolves.toBe(answer);
  });
});
