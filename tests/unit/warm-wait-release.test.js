// A request whose warm prompt-cache key was just rate-limited waits for it
// (src/sse/handlers/chat.ts, "[CACHE] waiting Nms for a key holding this
// conversation's prompt cache"). During that wait it keeps its client body,
// not what its last attempt sent: the encoded bytes and the translated and
// finalized bodies in the account loop's attempt cache are collectable. The
// attempt after the wait sends the same bytes and stores the same rows.
//
// Real path in-process: POST /v1/messages → handleChat → combo → account loop
// → chatCore → DefaultExecutor → a local OpenAI-compatible upstream with a
// warm key (served the conversation, then answers 429 once) and a cold one.
// chatCore is wrapped only to take weak references to the attempt cache.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { settle, socketBody } from "../helpers/heldStreams.js";
import { claudeCodeHeaders, conversation, countWaitLines, seedWarmCold, startWarmUpstream } from "../helpers/warmWait.js";

const failed = [];
vi.mock("open-sse/handlers/chatCore.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    handleChatCore: async (args) => {
      const result = await actual.handleChatCore(args);
      const last = args.attemptCache?.last;
      if (!result.success && last) {
        failed.push({
          cache: new WeakRef(last),
          bytes: new WeakRef(last.bytes),
          value: new WeakRef(last.value),
          source: new WeakRef(last.source),
          clientBody: new WeakRef(args.clientRawRequest.body),
        });
      }
      return result;
    },
  };
});

const WARM_KEY = "sk-warmwait-warm-not-a-real-key-00";
const COLD_KEY = "sk-warmwait-cold-not-a-real-key-00";

let tempDir;
let upstream;
let routerKey;
let POST;
let db;
let repo;
let waits;
const originalDataDir = process.env.DATA_DIR;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "10router-warm-wait-release-"));
  process.env.DATA_DIR = tempDir;
  waits = countWaitLines();
  upstream = await startWarmUpstream(WARM_KEY, { keepBodies: true });

  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
  await db.updateSettings({
    requireApiKey: true,
    enableObservability: true,
    comboStrategies: { kimi: { fallbackStrategy: "fallback" } },
  });
  routerKey = (await db.createApiKey("warm-wait", "warm-wait-machine")).key;
  await seedWarmCold(db, { baseUrl: `http://127.0.0.1:${upstream.port}/v1`, prefix: "ww", warmKey: WARM_KEY, coldKey: COLD_KEY });
  ({ POST } = await import("../../src/app/api/v1/messages/route.js"));
  repo = await import("@/lib/db/repos/requestDetailsRepo.js");
}, 60_000);

afterAll(async () => {
  waits?.restore();
  await new Promise((r) => (upstream ? upstream.server.close(r) : r()));
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

const post = (text) => POST(new Request("http://localhost/v1/messages", {
  method: "POST", headers: claudeCodeHeaders(routerKey), body: socketBody(text), duplex: "half",
}));

// Big enough to wait for a warm key (over CACHE_AFFINITY.minPromptTokens).
const turn = (i, messages) => conversation(i, { messages, tools: 17, toolResultChars: 13000 });

// One conversation's waited turn: its first turn (small) makes the warm key
// warm, then the big one is limited there once, waits, and resumes there.
async function waitedTurn(i, whileWaiting) {
  await (await post(turn(i, 3))).text();
  const up = upstream.state;
  up.arm(0);
  up.limitNext = 1;
  failed.length = 0;
  waits.reset();
  const pending = post(turn(i, 40));
  await vi.waitFor(() => expect(waits.count()).toBeGreaterThanOrEqual(1), { timeout: 15_000, interval: 5 });
  const during = await whileWaiting?.();
  const res = await pending;
  await res.text();
  expect(res.status).toBe(200);
  // Limited once, then served by the same warm key; the cold key was never asked.
  expect(up.bodies).toHaveLength(2);
  expect(up.resumed).toHaveLength(1);
  expect(up.cold).toBe(0);
  return during;
}

describe("a request waiting for a warm key", () => {
  // With request details at their default. With full ones on, the details'
  // own capped ring keeps the finalized body of the newest rows.
  it("lets go of its last attempt's bytes and translated body while it waits", async () => {
    const during = await waitedTurn(1, async () => {
      await settle();
      return {
        resumed: upstream.state.resumed.length > 0,
        attempts: failed.length,
        cache: failed[0]?.cache.deref() !== undefined,
        bytes: failed[0]?.bytes.deref() !== undefined,
        value: failed[0]?.value.deref() !== undefined,
        source: failed[0]?.source.deref() !== undefined,
        clientBody: failed[0]?.clientBody.deref() !== undefined,
      };
    });
    // Measured mid-wait, after the 429'd attempt had filled the cache.
    expect(during.resumed).toBe(false);
    expect(during.attempts).toBe(1);
    // The client body is still needed for the attempt after the wait.
    expect(during.clientBody).toBe(true);
    expect({ cache: during.cache, bytes: during.bytes, value: during.value, source: during.source })
      .toEqual({ cache: false, bytes: false, value: false, source: false });
  }, 30_000);

  it("sends the same bytes after the wait and stores the same request rows", async () => {
    // Full copies too ("Show full request details"); clearing them drops the cached setting.
    await db.updateSettings({ showSensitiveRequestDetails: true });
    await db.clearRequestDetailFullData();
    await repo.__test__.flush();
    await waitedTurn(2);
    const [limited, resumed] = upstream.state.bodies;
    expect(limited.length).toBeGreaterThan(100_000);
    expect(resumed.equals(limited)).toBe(true);

    await new Promise((r) => setTimeout(r, 20));
    await repo.__test__.flush();
    // This turn's rows, newest first: the reply's, then the 429's.
    const rows = (await db.getRequestDetails({ pageSize: 2 })).details;
    expect(rows.map((r) => r.status)).toEqual(["success", "error"]);
    const [ok, error] = rows;
    expect(ok.providerRequest).toEqual(error.providerRequest);
    expect(ok.request).toEqual(error.request);
    const full = await Promise.all(rows.map((r) => db.getRequestDetailFullData(r.id)));
    const sent = JSON.parse(limited.toString("utf8"));
    expect(full[0].providerRequest).toEqual(sent);
    expect(full[1].providerRequest).toEqual(sent);
    expect(full[0].request).toEqual(full[1].request);
  }, 30_000);
});
