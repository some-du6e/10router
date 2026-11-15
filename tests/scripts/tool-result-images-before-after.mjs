// Before/after for screenshots in tool results. Translates one Responses turn
// whose tool output holds a screenshot-sized image, through the router code at
// <root>, to a Claude-format and an OpenAI Chat target, and prints what the
// tool result looks like and how much of the body is text.
//
//   bun tests/scripts/tool-result-images-before-after.mjs <root> [--label Before] [--assert-clean]
//
// --assert-clean exits 1 when the image's base64 shows up in any text field.
import { randomBytes } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const root = path.resolve(args.find((a) => !a.startsWith("--")) ?? ".");
const label = args.includes("--label") ? args[args.indexOf("--label") + 1] : root;
const assertClean = args.includes("--assert-clean");

const load = async (rel) => {
  for (const ext of [".ts", ".js"]) {
    try { return await import(pathToFileURL(path.join(root, rel + ext)).href); } catch (e) { if (ext === ".js") throw e; }
  }
};
const { translateRequest } = await load("open-sse/translator/index");
const { FORMATS } = await load("open-sse/translator/formats");

// ~450 KB of image bytes, about the size of a full-screen JPEG screenshot.
const B64 = randomBytes(450_000).toString("base64");
const IMAGE_TOKENS = 1600; // the router's flat per-image estimate
const body = () => ({
  model: "claude-sonnet-4-5",
  input: [
    { type: "message", role: "user", content: [{ type: "input_text", text: "take a screenshot" }] },
    { type: "function_call", call_id: "call_1", name: "screenshot", arguments: "{}" },
    {
      type: "function_call_output",
      call_id: "call_1",
      output: [
        { type: "input_text", text: "Output:" },
        { type: "input_image", image_url: `data:image/jpeg;base64,${B64}`, detail: "auto" },
      ],
    },
  ],
  tools: [{ type: "function", name: "screenshot", parameters: { type: "object", properties: {} } }],
});

// Fields where an image belongs. Whatever is left is text the model reads.
const IMAGE_KEYS = new Set(["image_url", "inlineData", "inline_data", "images", "fileData"]);
function textOnly(value, images) {
  if (Array.isArray(value)) return value.map((v) => textOnly(v, images));
  if (!value || typeof value !== "object") return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (IMAGE_KEYS.has(k) || (k === "source" && v && typeof v === "object" && (v.type === "base64" || v.type === "url"))) {
      images.count++;
      continue;
    }
    out[k] = textOnly(v, images);
  }
  return out;
}

const describeContent = (content) => (typeof content === "string"
  ? `string, ${content.length.toLocaleString("en-US")} chars`
  : `[${content.map((b) => (b.type === "text" ? `text(${b.text.length.toLocaleString("en-US")} chars)` : b.type === "image" ? `image(${b.source?.type}, ${b.source?.media_type ?? b.source?.url})` : b.type)).join(", ")}]`);

let leaked = false;
const lines = [`== ${label}`];
for (const [name, target, pick] of [
  ["Claude-format upstream", FORMATS.CLAUDE, (out) => out.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).find((b) => b.type === "tool_result")],
  ["OpenAI Chat upstream", FORMATS.OPENAI, (out) => out.messages.find((m) => m.role === "tool")],
]) {
  const out = translateRequest(FORMATS.OPENAI_RESPONSES, target, "claude-sonnet-4-5", body(), true, null, null);
  const images = { count: 0 };
  const text = JSON.stringify(textOnly(out, images));
  const leak = text.includes(B64);
  leaked ||= leak;
  const tokens = Math.ceil(text.length / 4) + images.count * IMAGE_TOKENS;
  const tool = pick(out);
  lines.push(`${name}:`);
  lines.push(`  tool result content: ${describeContent(tool.content)}`);
  if (target === FORMATS.OPENAI) {
    const after = out.messages[out.messages.indexOf(tool) + 1];
    lines.push(`  next message: ${after ? `${after.role}, ${Array.isArray(after.content) ? after.content.map((p) => p.type).join(", ") : "text"}` : "none"}`);
  }
  lines.push(`  text in body: ${text.length.toLocaleString("en-US")} chars, images: ${images.count}`);
  lines.push(`  estimated input tokens: ~${tokens.toLocaleString("en-US")}`);
  lines.push(`  base64 inside a text field: ${leak ? "YES" : "no"}`);
}
console.log(lines.join("\n"));
if (process.env.GITHUB_STEP_SUMMARY) {
  const { appendFileSync } = await import("node:fs");
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, "```\n" + lines.join("\n") + "\n```\n");
}
if (assertClean && leaked) {
  console.error("FAIL: the image's base64 was sent as text");
  process.exit(1);
}
