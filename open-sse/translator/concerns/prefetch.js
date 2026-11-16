// Pre-fetch remote image URLs into base64 BEFORE translation, for target
// formats whose upstream providers cannot fetch remote URLs themselves
// (they require inline base64). Runs on the source-format body.
//
// Copy-on-write: only the body's own top-level keys are reassigned. The
// messages and blocks are the client's (the next combo model or account reuses
// them), so a block that gets inline data is replaced by a new one.
import { FORMATS } from "../formats.js";
import { fetchImageAsBase64, parseDataUri } from "./image.js";

// Targets that require inline base64 images (cannot accept remote URLs).
const TARGETS_NEED_BASE64 = new Set([
  FORMATS.GEMINI, FORMATS.GEMINI_CLI, FORMATS.VERTEX,
  FORMATS.ANTIGRAVITY, FORMATS.OLLAMA, FORMATS.KIRO,
]);

function isRemoteUrl(url) {
  return typeof url === "string" && (url.startsWith("http://") || url.startsWith("https://"));
}

// Map an array, returning the same array when no element changed.
function mapKeep(items, fn) {
  let out = null;
  items.forEach((item, i) => {
    const next = fn(item);
    if (next !== item) (out ??= items.slice())[i] = next;
  });
  return out || items;
}

// `inline(url)` returns the fetched image for a remote URL, or null to keep it.
function inlineOpenAIBlock(block, inline) {
  if (block?.type !== "image_url") return block;
  const isString = typeof block.image_url === "string";
  const url = isString ? block.image_url : block.image_url?.url;
  const fetched = isRemoteUrl(url) && inline(url);
  if (!fetched) return block;
  return { ...block, image_url: isString ? fetched.url : { ...block.image_url, url: fetched.url } };
}

function inlineClaudeBlock(block, inline) {
  if (block?.type !== "image" || block.source?.type !== "url" || !isRemoteUrl(block.source.url)) return block;
  const fetched = inline(block.source.url);
  if (!fetched) return block;
  return { ...block, source: { type: "base64", media_type: fetched.mimeType, data: fetched.url.split(",")[1] } };
}

function inlineGeminiPart(part, inline) {
  const uri = part?.fileData?.fileUri;
  const fetched = isRemoteUrl(uri) && inline(uri);
  if (!fetched) return part;
  const { fileData: _fileData, ...rest } = part;
  return { ...rest, inlineData: { mimeType: fetched.mimeType, data: fetched.url.split(",")[1] } };
}

function inlineMessages(messages, inlineBlock, inline) {
  if (!Array.isArray(messages)) return messages;
  return mapKeep(messages, (msg) => {
    if (!Array.isArray(msg?.content)) return msg;
    const content = mapKeep(msg.content, (block) => inlineBlock(block, inline));
    return content === msg.content ? msg : { ...msg, content };
  });
}

function inlineContents(contents, inline) {
  if (!Array.isArray(contents)) return contents;
  return mapKeep(contents, (c) => {
    if (!Array.isArray(c?.parts)) return c;
    const parts = mapKeep(c.parts, (part) => inlineGeminiPart(part, inline));
    return parts === c.parts ? c : { ...c, parts };
  });
}

// Visit every remote image URL in a source body. Sets body's own keys to new
// messages/contents where `inline` returned an image; leaves them otherwise.
function rewriteImages(body, sourceFormat, inline) {
  switch (sourceFormat) {
    case FORMATS.CLAUDE: {
      const messages = inlineMessages(body.messages, inlineClaudeBlock, inline);
      if (messages !== body.messages) body.messages = messages;
      break;
    }
    case FORMATS.GEMINI:
    case FORMATS.GEMINI_CLI:
    case FORMATS.VERTEX: {
      const contents = inlineContents(body.contents, inline);
      if (contents !== body.contents) body.contents = contents;
      break;
    }
    case FORMATS.ANTIGRAVITY: {
      const contents = inlineContents(body?.request?.contents, inline);
      if (contents !== body?.request?.contents) body.request = { ...body.request, contents };
      break;
    }
    default: {
      // OpenAI, Ollama, Kiro, Cursor, CommandCode and anything else OpenAI-shaped.
      const messages = inlineMessages(body.messages, inlineOpenAIBlock, inline);
      if (messages !== body.messages) body.messages = messages;
    }
  }
}

/**
 * Replace remote image URLs with base64 data when the target needs inline data.
 * No-op when target accepts remote URLs (e.g. openai, claude) or body has none.
 * Only body's own keys are reassigned; the messages and blocks it holds are not edited.
 * @returns {Promise<number>} count of images converted
 */
export async function prefetchRemoteImages(body, sourceFormat, targetFormat, options = {}) {
  if (!body || !TARGETS_NEED_BASE64.has(targetFormat)) return 0;
  const urls = [];
  rewriteImages(body, sourceFormat, (url) => { urls.push(url); return null; });
  if (!urls.length) return 0;

  const fetchedByUrl = new Map();
  for (const url of urls) {
    if (fetchedByUrl.has(url) || parseDataUri(url)) continue; // already inline
    fetchedByUrl.set(url, await fetchImageAsBase64(url, options));
  }

  let converted = 0;
  rewriteImages(body, sourceFormat, (url) => {
    const fetched = fetchedByUrl.get(url);
    if (fetched) converted++;
    return fetched || null;
  });
  return converted;
}
