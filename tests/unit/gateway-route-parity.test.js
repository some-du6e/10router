// Golden fixtures for the Go gateway's /v1/messages entry
// (gateway/internal/route, docs/GO_GATEWAY.md "Parity testing").
//
// Each case is a body sent to POST /v1/messages. It goes through what Node
// runs before routing (readJsonObject, the [1m] marker strip, missingModel,
// handleBypassRequest), and the fixture records Node's answer: a 400, a throw,
// the canned bypass reply, or the model it routes. The Go port must decline
// every body Node refuses, answers itself or throws on, and serve the rest
// unless the case says why it is stricter ("conservative": not the hot
// path's shape). The fixture also holds the next.config.mjs rewrites that
// reach /api/v1, from which the Go port's path list comes.
//
// Without ROUTE_RECORD this checks that Node still gives the committed
// answers. With ROUTE_RECORD=1 it writes them.
import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const { readJsonObject, missingModel } = await import("../../src/sse/utils/requestBody.js");
const { stripModelContextMarker } = await import("../../open-sse/utils/modelMarkers.js");
const { handleBypassRequest } = await import("../../open-sse/utils/bypassHandler.js");
const { initTranslators } = await import("../../open-sse/translator/index.js");
const { default: nextConfig } = await import("../../next.config.mjs");
const { SKIP_PATTERNS } = await import("../../open-sse/config/runtimeConfig.js");

const FIXTURE_FILE = fileURLToPath(new URL("../../gateway/internal/route/testdata/cases.json", import.meta.url));
const RECORD = process.env.ROUTE_RECORD === "1";
const CC = "claude-cli/2.1.0 (external, cli)";

const user = (content) => ({ role: "user", content });
const assistant = (content) => ({ role: "assistant", content });
const text = (t) => ({ type: "text", text: t });
const hot = (extra = {}) => ({ model: "main", stream: true, max_tokens: 1024, messages: [user("hello")], ...extra });

function build() {
  const cases = [];
  const add = (name, body, { ua = CC, ccFilterNaming = false, raw = null, conservative = "" } = {}) => {
    const bytes = raw ?? Buffer.from(JSON.stringify(body), "utf8");
    cases.push({ name, bodyBase64: Buffer.from(bytes).toString("base64"), ua, ccFilterNaming, conservative });
  };
  add("hot path", hot());
  add("hot path, other client", hot(), { ua: "custom-client/1.0" });
  add("hot path, no user agent", hot(), { ua: "" });
  add("1m marker", hot({ model: "main[1m]" }));
  add("1M marker", hot({ model: "main[1M]" }));
  add("1m marker with spaces", hot({ model: "  main[1m]  " }));
  add("spaces without a marker", hot({ model: " main " }));
  add("200k selector stays", hot({ model: "main[200k]" }));
  add("model is a provider id", hot({ model: "hot/model-a" }));
  add("no model", hot({ model: undefined }));
  add("empty model", hot({ model: "" }));
  add("blank model", hot({ model: "   " }));
  add("only a marker", hot({ model: "[1m]" }));
  add("number model", hot({ model: 5 }));
  add("non-ASCII model", hot({ model: "mäin" }), { conservative: "not printable ASCII" });
  add("model naming an Object.prototype member", hot({ model: "constructor" }), { conservative: "Object.prototype" });
  add("not JSON", null, { raw: Buffer.from("{nope") });
  add("array body", null, { raw: Buffer.from("[1,2]") });
  add("null body", null, { raw: Buffer.from("null") });
  add("string body", null, { raw: Buffer.from("\"x\"") });
  add("empty body", null, { raw: Buffer.alloc(0) });
  add("BOM", null, { raw: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(JSON.stringify(hot()))]) });
  add("invalid UTF-8 in a string", null, { raw: Buffer.concat([Buffer.from("{\"model\":\"main\",\"stream\":true,\"messages\":[{\"role\":\"user\",\"content\":\"a"), Buffer.from([0xff]), Buffer.from("\"}]}")]) });
  add("stream false", hot({ stream: false }), { conservative: "not stream: true" });
  add("stream missing", hot({ stream: undefined }), { conservative: "not stream: true" });
  add("stream as a string", hot({ stream: "true" }), { conservative: "not stream: true" });
  add("messages empty", hot({ messages: [] }), { conservative: "not a non-empty array" });
  add("messages missing", hot({ messages: undefined }), { conservative: "not a non-empty array" });
  add("messages is a string", hot({ messages: "hi" }), { conservative: "not a non-empty array" });
  add("a null message", hot({ messages: [user("hi"), null] }));
  add("a null message, other client", hot({ messages: [user("hi"), null] }), { ua: "custom-client/1.0", conservative: "a message that is not an object" });
  add("warmup, UA among others", hot({ messages: [user("Warmup")] }), { ua: "proxy-agent/1.0, claude-cli/2.1.0" });
  // Claude Code's requests Node answers itself.
  add("warmup", hot({ messages: [user("Warmup")] }));
  add("warmup in blocks", hot({ messages: [user([text("Warmup")])] }));
  add("warmup, two blocks", hot({ messages: [user([text("Warm"), text("up")])] }));
  add("warmup from another client", hot({ messages: [user("Warmup")] }), { ua: "custom-client/1.0" });
  add("warmup, capitalized UA", hot({ messages: [user("Warmup")] }), { ua: "Claude-CLI/2.1.0" });
  add("warmup, later message", hot({ messages: [user("hello"), assistant("hi"), user("Warmup")] }));
  add("title extraction", hot({ messages: [user("hello"), assistant([text("{")])] }));
  add("title-like string content", hot({ messages: [user("hello"), assistant("{")] }));
  add("title, object content", hot({ messages: [user("hello"), assistant({ 0: text("{") })] }));
  add("count", hot({ messages: [user("count")] }));
  add("count in blocks", hot({ messages: [user([text("count")])] }));
  add("count, two messages", hot({ messages: [user("count"), user("more")] }));
  add("skip pattern", hot({ messages: [user("Please write a 5-10 word title for the following conversation: x")] }));
  add("skip pattern across messages", hot({ messages: [user("Please write a 5-10 word"), assistant("ok"), user("title for the following conversation:")] }));
  add("skip pattern in a block", hot({ messages: [user([{ type: "image", source: {} }, text("Please write a 5-10 word title for the following conversation:")])] }));
  add("naming, filter on", hot({ system: [text("Answer with isNewTopic and a title")] }), { ccFilterNaming: true });
  add("naming, filter off", hot({ system: [text("Answer with isNewTopic and a title")] }));
  add("naming, string system", hot({ system: "isNewTopic" }), { ccFilterNaming: true });
  add("naming, system message", hot({ messages: [{ role: "system", content: "isNewTopic" }, user("hi")] }), { ccFilterNaming: true });
  add("naming, system message wins", hot({ system: "isNewTopic", messages: [{ role: "system", content: "plain" }, user("hi")] }), { ccFilterNaming: true });
  add("naming, null system block", hot({ system: [text("x"), null] }), { ccFilterNaming: true });
  add("naming, null system block, filter off", hot({ system: [text("x"), null] }));
  add("null block in the first message", hot({ messages: [user([text("x"), null])] }));
  add("null block in a later user message", hot({ messages: [user("hi"), assistant("ok"), user([null])] }));
  add("null block in an assistant message", hot({ messages: [user("hi"), assistant([null]), user("again")] }));
  add("non-string text", hot({ messages: [user([{ type: "text", text: 5 }])] }), { conservative: "text is not a string" });
  add("text block without text", hot({ messages: [user([{ type: "text" }]), user("Warmup")] }));
  return cases;
}

async function runNode(c) {
  const bytes = Buffer.from(c.bodyBase64, "base64");
  const parsed = await readJsonObject(new Request("http://localhost/v1/messages", { method: "POST", body: bytes }));
  if (parsed.error) return { status: parsed.error.status };
  const body = parsed.body;
  const { model: modelStr, contextMarker } = stripModelContextMarker(body.model);
  if (contextMarker) body.model = modelStr;
  if (missingModel(modelStr)) return { status: 400 };
  try {
    const bypass = handleBypassRequest(body, modelStr, c.ua, c.ccFilterNaming, "claude");
    return { model: modelStr, bypass: !!bypass };
  } catch (error) {
    return { threw: String(error?.message || error) };
  }
}

// next.config.mjs rewrites that land on /api/v1: their sources are the paths
// the gateway's route answers (plus /api/v1/messages itself).
async function apiV1Sources() {
  const rewrites = await nextConfig.rewrites();
  return rewrites.filter((r) => r.destination === "/api/v1/:path*").map((r) => r.source);
}

const TABLES_FILE = fileURLToPath(new URL("../../gateway/internal/route/tables.json", import.meta.url));
const tablesText = () => JSON.stringify({ skipPatterns: SKIP_PATTERNS }, null, 2) + "\n";

describe("/v1/messages entry fixtures for the Go gateway", () => {
  it("keeps the table export the Go port embeds", () => {
    if (RECORD) writeFileSync(TABLES_FILE, tablesText());
    expect(readFileSync(TABLES_FILE, "utf8"), "regenerate with ROUTE_RECORD=1").toBe(tablesText());
  });

  it("answers every body as the committed fixture says", async () => {
    await initTranslators();
    const cases = build();
    for (const c of cases) c.node = await runNode(c);
    const text = JSON.stringify({ apiV1Rewrites: await apiV1Sources(), cases }, null, 1) + "\n";
    if (RECORD) writeFileSync(FIXTURE_FILE, text);
    expect(readFileSync(FIXTURE_FILE, "utf8"), "Node's /v1/messages entry changed: regenerate with ROUTE_RECORD=1 and update gateway/internal/route").toBe(text);
  });
});
