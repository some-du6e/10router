// One non-streaming call through a real SDK, printed as one JSON line:
//   SDK_DIR=<dir with the SDKs installed> node sdk-client.mjs <kind> <baseUrl> <model>
// kind: anthropic (messages.create, stream:false, as Claude Code's non-streaming
// fallback sends it), chat (chat.completions.create), responses (responses.create).
// outcome: "reply" (text holds the answer), "error-body" (a 200 whose body is
// an error), or "threw" (status/name/message of what the SDK threw).
// No SDK retries, so a 524 shows once.
import { createRequire } from "node:module";
import path from "node:path";

const [kind, baseURL, model] = process.argv.slice(2);
const require = createRequire(path.join(process.env.SDK_DIR || process.cwd(), "noop.js"));
const apiKey = process.env.E2E_API_KEY;
const opts = { apiKey, maxRetries: 0, timeout: 400_000 };
const started = Date.now();

async function call() {
  if (kind === "anthropic") {
    const Anthropic = require("@anthropic-ai/sdk").default;
    const r = await new Anthropic({ ...opts, baseURL }).messages.create({ model, max_tokens: 64, stream: false, messages: [{ role: "user", content: "ping" }] });
    return r.type === "error" ? { outcome: "error-body", error: r.error } : { outcome: "reply", text: r.content?.[0]?.text };
  }
  const OpenAI = require("openai").default;
  const client = new OpenAI({ ...opts, baseURL: `${baseURL}/v1` });
  if (kind === "chat") {
    const r = await client.chat.completions.create({ model, messages: [{ role: "user", content: "ping" }] });
    return r.error ? { outcome: "error-body", error: r.error } : { outcome: "reply", text: r.choices?.[0]?.message?.content };
  }
  const r = await client.responses.create({ model, input: "ping" });
  return r.status === "failed" || r.error ? { outcome: "error-body", status: r.status, error: r.error } : { outcome: "reply", text: r.output_text };
}

let result;
try {
  result = await call();
} catch (e) {
  result = { outcome: "threw", status: e.status ?? null, name: e.constructor?.name, message: String(e.message).slice(0, 300) };
}
console.log(JSON.stringify({ kind, model, seconds: Math.round((Date.now() - started) / 1000), ...result }));
