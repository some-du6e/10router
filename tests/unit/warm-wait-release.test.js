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
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { claudeCodeBody } from "../helpers/claudeCodeBody.js";
import { settle, socketBody } from "../helpers/heldStreams.js";

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

const MODEL = "kimi-k3";
const NODE_ID = "openai-compatible-chat-warmwait";
const WARM_KEY = "sk-warmwait-warm-not-a-real-key-00";
const COLD_KEY = "sk-warmwait-cold-not-a-real-key-00";
const WAIT_LINE = "for a key holding this conversation's prompt cache";

const base = { id: "chatcmpl-ww", object: "chat.completion.chunk", created: 1700000000, model: MODEL };
const chunk = (obj) => `data: ${JSON.stringify({ ...base, ...obj })}\n\n`;

// Warm-key requests: the first `limit` get a 429, the rest a short reply. Each body is kept.
const up = { limit: 0, warm: [], cold: 0 };

function startUpstream() {
  const server = http.createServer((req, res) => {
    const parts = [];
    req.on("data", (part) => parts.push(part));
    req.on("end", () => {
      const body = Buffer.concat(parts);
      if (!(req.headers.authorization || "").includes(WARM_KEY)) up.cold++;
      else {
        up.warm.push(body);
        if (up.limit > 0) {
          up.limit--;
          res.writeHead(429, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { message: "Too many requests", type: "requests", code: "429" } }));
          return;
        }
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(chunk({ choices: [{ index: 0, delta: { role: "assistant", content: "Hi" }, finish_reason: null }] }));
      res.write(chunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }));
      res.write(chunk({ choices: [], usage: { prompt_tokens: 70000, completion_tokens: 1, total_tokens: 70001 } }));
      res.end("data: [DONE]\n\n");
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

let tempDir;
let upstream;
let routerKey;
let POST;
let db;
let repo;
let waitLines = 0;
const originalDataDir = process.env.DATA_DIR;
const quiet = {};

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "10router-warm-wait-release-"));
  process.env.DATA_DIR = tempDir;
  for (const k of ["log", "info", "warn", "debug", "error"]) {
    quiet[k] = console[k];
    console[k] = (...args) => { if (String(args[0]).includes(WAIT_LINE)) waitLines++; };
  }
  upstream = await startUpstream();
  const baseUrl = `http://127.0.0.1:${upstream.address().port}/v1`;

  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
  await db.updateSettings({
    requireApiKey: true,
    enableObservability: true,
    comboStrategies: { kimi: { fallbackStrategy: "fallback" } },
  });
  routerKey = (await db.createApiKey("warm-wait", "warm-wait-machine")).key;
  await db.createProviderNode({ id: NODE_ID, type: "openai-compatible", name: "WarmWait", prefix: "ww", apiType: "chat", baseUrl });
  // Fill-first ranks the warm key first, so the cold key is the pick while it is locked.
  for (const [name, apiKey] of [["ww-warm", WARM_KEY], ["ww-cold", COLD_KEY]]) {
    await db.createProviderConnection({
      provider: NODE_ID, authType: "apikey", name, apiKey, isActive: true, testStatus: "active",
      providerSpecificData: { prefix: "ww", apiType: "chat", baseUrl, nodeName: "WarmWait" },
    });
  }
  await db.createCombo({ name: "kimi", models: [`ww/${MODEL}`] });
  ({ POST } = await import("../../src/app/api/v1/messages/route.js"));
  repo = await import("@/lib/db/repos/requestDetailsRepo.js");
}, 60_000);

afterAll(async () => {
  for (const [k, fn] of Object.entries(quiet)) console[k] = fn;
  await new Promise((r) => upstream?.close(r));
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

const post = (text) => POST(new Request("http://localhost/v1/messages", {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "user-agent": "claude-cli/2.1.0 (external, cli)",
    "x-api-key": routerKey,
    "anthropic-version": "2023-06-01",
    "anthropic-beta": "claude-code-20250219,interleaved-thinking-2025-05-14",
    "x-app": "cli",
  },
  body: socketBody(text),
  duplex: "half",
}));

// Big enough to wait for a warm key (over CACHE_AFFINITY.minPromptTokens).
function conversation(i, messages) {
  const body = claudeCodeBody("kimi", { messages, toolResultChars: 13000 });
  body.messages[0].content[1].text = `Fix the bug in the stream handler, conversation ${i}.`;
  body.metadata = { user_id: `user_ww_account__session_${String(i).padStart(8, "0")}-0000-0000-0000-000000000000` };
  return JSON.stringify(body);
}

async function until(check, ms = 15_000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

const drain = async (res) => {
  const reader = res.body.getReader();
  for (;;) if ((await reader.read()).done) break;
};

// One conversation's waited turn: its first turn (small) makes the warm key
// warm, then the big one is limited there once, waits, and resumes there.
async function waitedTurn(i, whileWaiting) {
  await drain(await post(conversation(i, 3)));
  Object.assign(up, { limit: 1, warm: [], cold: 0 });
  failed.length = 0;
  waitLines = 0;
  const pending = post(conversation(i, 40));
  await until(() => waitLines >= 1);
  const during = await whileWaiting?.();
  const res = await pending;
  await drain(res);
  expect(res.status).toBe(200);
  // Limited once, then served by the same warm key; the cold key was never asked.
  expect(up.warm).toHaveLength(2);
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
        resumed: up.warm.length > 1,
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
    const [limited, resumed] = up.warm;
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
