// Shared TTS helpers
import { Buffer } from "node:buffer";

export const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36";

// Convert upstream Response (binary audio) to { base64, format }
export async function responseToBase64(res, defaultFormat = "mp3") {
  const buf = await res.arrayBuffer();
  if (buf.byteLength < 100) throw new Error("Upstream returned empty audio");
  return { base64: Buffer.from(buf).toString("base64"), format: formatFromContentType(res.headers.get("content-type"), defaultFormat) };
}

// The audio format an upstream Content-Type names, or `fallback` when it names none we know.
export function formatFromContentType(contentType, fallback = "mp3") {
  const ctype = (contentType || "").toLowerCase();
  if (ctype.includes("wav")) return "wav";
  if (ctype.includes("mpeg") || ctype.includes("mp3")) return "mp3";
  if (ctype.includes("ogg")) return "ogg";
  if (ctype.includes("opus")) return "opus";
  if (ctype.includes("aac")) return "aac";
  if (ctype.includes("flac")) return "flac";
  if (ctype.includes("pcm")) return "pcm";
  return fallback;
}

// The message of an upstream error body: OpenAI-style `error.message`, a string
// `error`, a bare `message`, or a FastAPI `detail` (a string, `{ message }`, or
// `[{ msg }]`). Fields that aren't non-empty strings are skipped.
export function upstreamErrorMessage(text, status) {
  const fallback = `Upstream error (${status})`;
  const str = (value) => (typeof value === "string" && value.trim() ? value : null);
  try {
    const parsed = JSON.parse(text);
    const detail = parsed?.detail;
    const detailMsg = Array.isArray(detail)
      ? detail.map((d) => str(d?.msg)).filter(Boolean).join("; ")
      : str(detail) || str(detail?.message);
    return str(parsed?.error?.message) || str(parsed?.error) || str(parsed?.message) || str(detailMsg) || str(text) || fallback;
  } catch {
    return str(text) || fallback;
  }
}

export async function throwUpstreamError(res) {
  const text = await res.text().catch(() => "");
  throw new Error(upstreamErrorMessage(text, res.status));
}

// Parse `model` string as "modelId/voiceId" — match against known model list (longest prefix wins)
export function parseModelVoice(model, defaultModel = "", defaultVoice = "", knownModels = []) {
  if (!model) return { modelId: defaultModel, voiceId: defaultVoice };
  const known = knownModels.map((m) => m.id || m).filter(Boolean).sort((a, b) => b.length - a.length);
  for (const id of known) {
    if (model === id) return { modelId: id, voiceId: defaultVoice };
    if (model.startsWith(`${id}/`)) return { modelId: id, voiceId: model.slice(id.length + 1) };
  }
  const idx = model.lastIndexOf("/");
  if (idx > 0) return { modelId: model.slice(0, idx), voiceId: model.slice(idx + 1) };
  return { modelId: defaultModel || model, voiceId: defaultVoice || model };
}
