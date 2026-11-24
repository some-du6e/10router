// Shared by the tests, bench and E2E that put requests into a warm-key wait
// (src/sse/handlers/chat.ts: "[CACHE] waiting Nms for a key holding this
// conversation's prompt cache"): Claude Code shaped conversations, the client
// headers, and an OpenAI-compatible upstream with a warm key and a cold one.
import crypto from "node:crypto";
import http from "node:http";
import { claudeCodeBody } from "./claudeCodeBody.js";

export const WAIT_LINE = "for a key holding this conversation's prompt cache";

/** Conversation `i`'s turn: its own first message (so its own prompt-cache key) and session. */
export function conversation(i, { model = "kimi", messages, tools = 24, toolResultChars = 22000 }) {
  const body = claudeCodeBody(model, { messages, tools, toolResultChars });
  body.messages[0].content[1].text = `Fix the bug in the stream handler, conversation ${i}.`;
  body.metadata = { user_id: `user_ww_account__session_${String(i).padStart(8, "0")}-0000-0000-0000-000000000000` };
  return JSON.stringify(body);
}

export const claudeCodeHeaders = (key = null) => ({
  "content-type": "application/json",
  "user-agent": "claude-cli/2.1.0 (external, cli)",
  ...(key ? { "x-api-key": key } : {}),
  "anthropic-version": "2023-06-01",
  "anthropic-beta": "claude-code-20250219,interleaved-thinking-2025-05-14",
  "x-app": "cli",
});

const MODEL = "kimi-k3";
const base = { id: "chatcmpl-ww", object: "chat.completion.chunk", created: 1700000000, model: MODEL };
const chunk = (obj) => `data: ${JSON.stringify({ ...base, ...obj })}\n\n`;

function reply(res) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  res.write(chunk({ choices: [{ index: 0, delta: { role: "assistant", content: "Hi" }, finish_reason: null }] }));
  res.write(chunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }));
  res.write(chunk({ choices: [], usage: { prompt_tokens: 250000, completion_tokens: 1, total_tokens: 250001 } }));
  res.end("data: [DONE]\n\n");
}

function limit(res) {
  res.writeHead(429, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: { message: "Too many requests", type: "requests", code: "429" } }));
}

/**
 * An upstream request handler. Requests whose Authorization doesn't carry
 * `warmKey` are served and counted in `state.cold`. Warm-key ones: the next
 * `state.limitNext` get a 429 at once; with `state.barrier` set, the next that
 * many are held until all have arrived, then each gets a 429, and warm
 * requests after those count as resumed. Each warm body's SHA-256 goes to
 * `state.limited` or `state.resumed`; with `keepBodies`, the bodies to `state.bodies`.
 */
export function warmUpstream(warmKey, { keepBodies = false } = {}) {
  const state = { limitNext: 0, barrier: 0, held: [], limited: [], resumed: [], bodies: [], cold: 0 };
  // Starts a new round: `barrier` warm requests are limited together.
  state.arm = (barrier) => Object.assign(state, { barrier, limited: [], resumed: [], bodies: [], cold: 0 });
  const handle = (req, res) => {
    const hash = crypto.createHash("sha256");
    const parts = [];
    req.on("data", (part) => {
      hash.update(part);
      if (keepBodies) parts.push(part);
    });
    req.on("end", () => {
      const digest = hash.digest("hex");
      if (!(req.headers.authorization || "").includes(warmKey)) {
        state.cold++;
        reply(res);
        return;
      }
      if (keepBodies) state.bodies.push(Buffer.concat(parts));
      if (state.limitNext > 0) {
        state.limitNext--;
        state.limited.push(digest);
        limit(res);
        return;
      }
      if (state.barrier > 0) {
        state.held.push(res);
        state.limited.push(digest);
        if (state.held.length < state.barrier) return;
        state.barrier = 0;
        for (const held of state.held.splice(0)) limit(held);
        return;
      }
      if (state.limited.length) state.resumed.push(digest);
      reply(res);
    });
  };
  return { state, handle };
}

/** warmUpstream on 127.0.0.1, an ephemeral port unless `port` is given. */
export function startWarmUpstream(warmKey, { port = 0, ...options } = {}) {
  const { state, handle } = warmUpstream(warmKey, options);
  const server = http.createServer(handle);
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve({ server, state, port: server.address().port })));
}

/**
 * Seed an OpenAI-compatible node `prefix` with a warm key ranked first (so
 * the cold key is fill-first's pick while the warm one is locked), a cold one,
 * and a fallback combo `kimi` → `<prefix>/kimi-k3`. Returns the warm key's id.
 */
export async function seedWarmCold(db, { baseUrl, prefix, warmKey, coldKey }) {
  const nodeId = `openai-compatible-chat-${prefix}`;
  await db.createProviderNode({ id: nodeId, type: "openai-compatible", name: prefix, prefix, apiType: "chat", baseUrl });
  for (const [name, apiKey] of [[`${prefix}-warm`, warmKey], [`${prefix}-cold`, coldKey]]) {
    await db.createProviderConnection({
      provider: nodeId, authType: "apikey", name, apiKey, isActive: true, testStatus: "active",
      providerSpecificData: { prefix, apiType: "chat", baseUrl, nodeName: prefix },
    });
  }
  await db.createCombo({ name: "kimi", models: [`${prefix}/${MODEL}`] });
  return { nodeId, model: MODEL, warmId: (await db.getProviderConnections({ provider: nodeId })).find((c) => c.name === `${prefix}-warm`).id };
}

/** Silence the console, counting the lines that announce a warm-key wait. Returns { count(), restore() }. */
export function countWaitLines() {
  const saved = {};
  let n = 0;
  for (const k of ["log", "info", "warn", "debug", "error"]) {
    saved[k] = console[k];
    console[k] = (...args) => { if (String(args[0]).includes(WAIT_LINE)) n++; };
  }
  return {
    count: () => n,
    reset: () => { n = 0; },
    restore: () => Object.assign(console, saved),
  };
}
