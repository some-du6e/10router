// The input-token estimates walk the body instead of serializing it, and must
// give exactly what serializing it gave: JSON length with inline files blanked
// (/ 4), non-ASCII counted extra for billing, files by kind.
import { describe, expect, it } from "vitest";
import { estimateInputTokens, estimateBillingInputTokens, promptTokenEstimates, weighChars } from "../../open-sse/utils/usageTracking.js";
import { IMAGE_TOKEN_ESTIMATE } from "../../open-sse/config/mediaConfig.js";
import { claudeCodeBody } from "../helpers/claudeCodeBody.js";

// The estimate as it was computed before, from JSON.stringify with a replacer.
function reference(body) {
  const DATA_URL = /^data:([^;,]+);base64,/;
  const payload = (mime, base64) => (/^image\//i.test(mime || "") ? IMAGE_TOKEN_ESTIMATE : Math.ceil((base64.length * 3) / 4 / 4));
  let inline = 0;
  let json;
  try {
    json = JSON.stringify(body, function replacer(key, value) {
      if (typeof value !== "string" || value.length <= 256) return value;
      const url = DATA_URL.exec(value);
      if (url) { inline += payload(url[1], value.slice(url[0].length)); return ""; }
      if (key === "data" && this && typeof this === "object") {
        const mime = this.media_type || this.mimeType || this.mime_type || (this.format ? `audio/${this.format}` : null);
        if (this.type === "base64" || mime) { inline += payload(mime, value); return ""; }
      }
      return value;
    });
  } catch {
    return { input: 0, billing: 0 };
  }
  if (typeof json !== "string") return { input: 0, billing: 0 };
  return { input: Math.ceil(json.length / 4) + inline, billing: Math.ceil(weighChars(json) / 4) + inline };
}

const b64 = (n) => "QUJD".repeat(Math.ceil(n / 4)).slice(0, n);

const bodies = {
  "claude code": claudeCodeBody("m"),
  "escapes and control characters": { messages: [{ role: "user", content: "quote \" backslash \\ tab \t nl \n cr \r ff \f bs \b nul \u0000 bell \u0007 del \u007f" }] },
  "non-ASCII, emoji and line separators": { messages: [{ role: "user", content: "日本語のテキスト 😀👍🏽 café     ñ" }], "ключ": "значение" },
  "lone surrogates": { messages: [{ role: "user", content: "a\ud800b\udc00c\ud83d" }] },
  numbers: { a: 1, b: -0, c: 1e21, d: 1.5e-7, e: NaN, f: Infinity, g: -Infinity, h: 123456789.123 },
  "undefined, functions and holes": { a: undefined, b: () => 1, c: [undefined, () => 1, Symbol("s"), null, true, false], d: [, 1], e: Symbol("x") },
  "empty containers": { a: {}, b: [], c: [[]], d: [{}], e: "" },
  "Anthropic image and document": {
    messages: [{ role: "user", content: [
      { type: "image", source: { type: "base64", media_type: "image/png", data: b64(5000) } },
      { type: "document", source: { type: "base64", media_type: "application/pdf", data: b64(9001) } },
      { type: "text", text: "describe" },
    ] }],
  },
  "data URLs, Gemini and audio": {
    messages: [{ role: "user", content: [
      { type: "image_url", image_url: { url: `data:image/jpeg;base64,${b64(4000)}` } },
      { type: "file", file: { file_data: `data:application/pdf;base64,${b64(3000)}` } },
      { type: "input_audio", input_audio: { data: b64(2000), format: "wav" } },
    ] }],
    contents: [{ parts: [{ inlineData: { mimeType: "image/webp", data: b64(700) } }, { inlineData: { mime_type: "audio/mp3", data: b64(300) } }] }],
    short: `data:image/png;base64,${b64(10)}`,
    notMedia: { data: b64(1000) },
    arrayOfData: [b64(600), `data:text/plain;base64,${b64(600)}`],
  },
  "null prototype": Object.assign(Object.create(null), { messages: [{ role: "user", content: "hi" }] }),
  "toJSON and class instances": { when: new Date(0), own: { toJSON: () => ({ replaced: "yes" }) }, map: new Map([[1, 2]]) },
};

describe("prompt token estimates", () => {
  it.each(Object.entries(bodies))("match serializing the body: %s", (_, body) => {
    const expected = reference(body);
    expect(estimateInputTokens(body)).toBe(expected.input);
    expect(estimateBillingInputTokens(body)).toBe(expected.billing);
    expect(promptTokenEstimates(body)).toEqual({ inputTokens: expected.input, billingInputTokens: expected.billing });
  });

  it("is 0 for a body that can't be serialized", () => {
    const cyclic = { a: 1 };
    cyclic.self = cyclic;
    expect(promptTokenEstimates(cyclic)).toEqual({ inputTokens: 0, billingInputTokens: 0 });
    expect(promptTokenEstimates({ big: 10n })).toEqual({ inputTokens: 0, billingInputTokens: 0 });
    expect(promptTokenEstimates(null)).toEqual({ inputTokens: 0, billingInputTokens: 0 });
  });

  it("matches on deep nesting past the walk's limit", () => {
    let deep = { leaf: "x" };
    for (let i = 0; i < 1500; i++) deep = { child: deep };
    expect(estimateInputTokens(deep)).toBe(reference(deep).input);
    expect(estimateBillingInputTokens(deep)).toBe(reference(deep).billing);
  });
});
