// A key demoted on one model with nothing served since gets one try at a time
// on other models (sse/services/auth.js, claimSpreadProbe). When the attempt
// on such a try ends without a lock or a success, chat.ts must still free that
// try, or no other key's try goes out on that model for probeLeaseMs. Runs the
// real chat loop, auth.js and SQLite repo, with handleChatCore stubbed.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ core: [] }));

vi.mock("next/server", () => ({
  NextResponse: { json: (body, init = {}) => new Response(JSON.stringify(body), { status: init.status || 200 }) },
}));
vi.mock("@/sse/utils/logger.js", () => ({
  debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), request: vi.fn(), response: vi.fn(), stream: vi.fn(),
  maskKey: (k) => String(k).slice(0, 4),
}));
vi.mock("@/sse/services/model.js", () => ({
  getModelInfo: async (m) => ({ provider: m.split("/")[0], model: m.split("/").slice(1).join("/") }),
  getComboModels: async () => null,
  comboLookupName: (name) => name,
}));
vi.mock("@/sse/services/tokenRefresh.js", () => ({
  checkAndRefreshToken: async (_p, c) => c,
  updateProviderCredentials: async () => {},
}));
vi.mock("open-sse/handlers/chatCore.js", async (importOriginal) => ({
  ...(await importOriginal()),
  handleChatCore: async (args) => state.core.shift()(args),
}));

const originalDataDir = process.env.DATA_DIR;
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "10router-spread-lease-"));
process.env.DATA_DIR = tempDir;

const MIN = 60 * 1000;
const DEAD_403 = '[403]: {"code":"000000","message":"Key barred from this endpoint"}';
let db, auth, handleChat, provider, seq = 0;

beforeAll(async () => {
  db = await import("@/lib/db/index.js");
  auth = await import("@/sse/services/auth.js");
  ({ handleChat } = await import("@/sse/handlers/chat.js"));
  await db.updateSettings({ requireApiKey: false });
});

afterAll(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-23T00:44:00.000Z"));
  provider = `openai-compatible-spread-lease-${++seq}`;
  state.core = [];
});

const addKey = (name) => db.createProviderConnection({
  provider, authType: "apikey", name, apiKey: `sk-test-${name}-0123456789`,
  providerSpecificData: { baseUrl: "https://spread-lease.test/v1" },
});

// key-a and key-b demoted on m1 with nothing served since, ahead of key-h,
// which works; then 11 minutes on.
async function twoDeadAhead() {
  const a = await addKey("a");
  const b = await addKey("b");
  const h = await addKey("h");
  for (const key of [a, b]) {
    for (let i = 0; i < 5; i++) {
      if (i > 0) vi.advanceTimersByTime(3 * MIN);
      const creds = await auth.getProviderCredentials(provider, new Set([a.id, b.id].filter((id) => id !== key.id)), "m1");
      await auth.clearAccountError(h.id, creds?.connectionId === h.id ? creds : { id: h.id }, "m1");
      await auth.markAccountUnavailable(key.id, 403, DEAD_403, provider, "m1");
    }
  }
  vi.advanceTimersByTime(11 * MIN);
  return { a, b, h };
}

const held = (id) => [...global._authEvents.spreadLeases.values()].filter((lease) => lease.connectionId === id);
const served = () => ({ success: true, response: new Response("{}", { status: 200 }) });
const chat = (signal) => handleChat(new Request("http://localhost/v1/chat/completions", {
  method: "POST", headers: { "Content-Type": "application/json" }, signal,
  body: JSON.stringify({ model: `${provider}/m2`, messages: [{ role: "user", content: "hi" }] }),
}));

describe("a spread try on another model", () => {
  it.each([
    ["the attempt throws", () => { throw new Error("socket hang up"); }, () => [served]],
    ["the attempt fails with a request error, which locks nothing", () => ({
      success: false, status: 400, error: "[400]: unknown parameter: foo", response: new Response("{}", { status: 400 }),
    }), () => [served]],
    ["the client goes away during the attempt", null, () => []],
  ])("is freed when %s, and the next due key takes the next try at once", async (_label, firstAttempt, after) => {
    const { a, b } = await twoDeadAhead();
    const controller = new AbortController();
    const tried = [];
    state.core.push((args) => {
      tried.push(args.credentials.connectionId);
      if (firstAttempt) return firstAttempt();
      controller.abort();
      return { success: false, status: 499, error: "client closed", response: new Response("{}", { status: 499 }) };
    });
    for (const next of after()) state.core.push((args) => { tried.push(args.credentials.connectionId); return next(); });
    await chat(controller.signal).catch(() => {});
    expect(tried[0]).toBe(a.id);
    expect(held(a.id)).toEqual([]);
    expect((await auth.getProviderCredentials(provider, null, "m2")).connectionId).toBe(b.id);
  });
});
