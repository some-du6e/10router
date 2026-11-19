// Pre-fetch remote image URLs into base64 BEFORE translation, for target
// formats whose upstream providers cannot fetch remote URLs themselves
// (they require inline base64). Runs on the attempt's copy of the source-format
// body, which owns its messages and blocks but not the objects inside a block,
// so a block's fields are replaced rather than edited.
import { FORMATS } from "../formats.js";
import { CLAUDE_BLOCK, OPENAI_BLOCK } from "../schema/index.js";
import { fetchImageAsBase64 } from "./image.js";

// Targets that require inline base64 images (cannot accept remote URLs).
const TARGETS_NEED_BASE64 = new Set([
  FORMATS.GEMINI, FORMATS.GEMINI_CLI, FORMATS.VERTEX,
  FORMATS.ANTIGRAVITY, FORMATS.OLLAMA, FORMATS.KIRO,
]);

// Images fetched for one client request, so a fallback to another account or
// combo model, a fusion panel or its judge doesn't download them again. Keyed
// by an object every attempt at the request shares (chatCore passes the
// client's abort signal); an entry goes with the request. A failed fetch isn't
// kept, so the next attempt tries it again.
const fetchedByRequest = new WeakMap();

function requestCache(key) {
  if (!key || typeof key !== "object") return new Map();
  let cache = fetchedByRequest.get(key);
  if (!cache) fetchedByRequest.set(key, (cache = new Map()));
  return cache;
}

/**
 * fetchImageAsBase64, at most once per URL for one client request.
 * @param {string} url
 * @param {object} [options] - `cacheKey` (the request's shared object), plus fetchImageAsBase64's options
 * @returns {Promise<{url: string, mimeType: string} | null>}
 */
export function fetchImageOnce(url, { cacheKey, ...options } = {}) {
  const cache = requestCache(cacheKey);
  if (!cache.has(url)) {
    const pending = fetchImageAsBase64(url, options).catch(() => null);
    cache.set(url, pending);
    pending.then((image) => { if (!image && cache.get(url) === pending) cache.delete(url); });
  }
  return cache.get(url);
}

function isRemoteUrl(url) {
  return typeof url === "string" && (url.startsWith("http://") || url.startsWith("https://"));
}

// Collect {url, inline(image)} for every remote image URL in a source body.
function collectImageRefs(body, sourceFormat) {
  const refs = [];
  const pushOpenAI = (messages) => {
    for (const msg of messages || []) {
      if (!Array.isArray(msg?.content)) continue;
      for (const block of msg.content) {
        if (block?.type !== OPENAI_BLOCK.IMAGE_URL) continue;
        const isString = typeof block.image_url === "string";
        const url = isString ? block.image_url : block.image_url?.url;
        if (isRemoteUrl(url)) refs.push({ url, inline: (image) => {
          block.image_url = isString ? image.url : { ...block.image_url, url: image.url };
        } });
      }
    }
  };
  const pushGemini = (contents) => {
    for (const c of contents || []) {
      for (const p of c?.parts || []) {
        const uri = p?.fileData?.fileUri;
        if (isRemoteUrl(uri)) refs.push({ url: uri, inline: (image) => {
          delete p.fileData;
          p.inlineData = { mimeType: image.mimeType, data: image.url.split(",")[1] };
        } });
      }
    }
  };

  switch (sourceFormat) {
    case FORMATS.OPENAI:
    case FORMATS.OLLAMA:
    case FORMATS.KIRO:
    case FORMATS.CURSOR:
    case FORMATS.COMMANDCODE:
      pushOpenAI(body.messages);
      break;
    case FORMATS.CLAUDE:
      for (const msg of body.messages || []) {
        if (!Array.isArray(msg?.content)) continue;
        for (const block of msg.content) {
          if (block?.type === CLAUDE_BLOCK.IMAGE && block.source?.type === "url" && isRemoteUrl(block.source.url)) {
            refs.push({ url: block.source.url, inline: (image) => {
              block.source = { type: "base64", media_type: image.mimeType, data: image.url.split(",")[1] };
            } });
          }
        }
      }
      break;
    case FORMATS.GEMINI:
    case FORMATS.GEMINI_CLI:
    case FORMATS.VERTEX:
      pushGemini(body.contents);
      break;
    case FORMATS.ANTIGRAVITY:
      pushGemini(body?.request?.contents);
      break;
    default:
      pushOpenAI(body.messages);
  }
  return refs;
}

/**
 * Replace remote image URLs with base64 data when the target needs inline data.
 * No-op when target accepts remote URLs (e.g. openai, claude) or body has none.
 * `options.cacheKey` shares fetched images between attempts at one client
 * request (see fetchImageOnce).
 * @returns {Promise<number>} count of images converted
 */
export async function prefetchRemoteImages(body, sourceFormat, targetFormat, options = {}) {
  if (!body || !TARGETS_NEED_BASE64.has(targetFormat)) return 0;
  const refs = collectImageRefs(body, sourceFormat);
  if (!refs.length) return 0;

  const images = new Map();
  for (const url of new Set(refs.map((ref) => ref.url))) {
    images.set(url, await fetchImageOnce(url, options));
  }

  let converted = 0;
  for (const ref of refs) {
    const image = images.get(ref.url);
    if (!image) continue;
    ref.inline(image);
    converted++;
  }
  return converted;
}
