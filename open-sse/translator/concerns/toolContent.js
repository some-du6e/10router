// Tool results that carry images, such as a computer-use or browser tool's
// screenshot. A Responses client sends them as an array `output`, the Chat
// pivot carries them as content parts, and each target gets them as images it
// can read, as the image's URL, or as a short placeholder.
import { ROLE, OPENAI_BLOCK, RESPONSES_ITEM } from "../schema/index.js";
import { parseDataUri } from "./image.js";
import {
  MEDIA_OMITTED_TEXT,
  INLINE_BASE64_MIN_CHARS,
  SCRUBBED_DATA_URI_MIME,
  imageAttachedBelowText,
  imageUrlText,
} from "../../config/mediaConfig.js";

// Starts only at a literal "data:" and never backtracks into the payload, so
// it runs in linear time however the text is shaped.
const DATA_URI = /data:([\w.+-]+\/[\w.+-]+);base64,[A-Za-z0-9+/=]+/g;
const DATA_URI_PREFIX_CHARS = ";base64,".length + "data:".length;

const dataUriText = (match, mime) => {
  if (!SCRUBBED_DATA_URI_MIME.test(mime) || match.length - mime.length - DATA_URI_PREFIX_CHARS < INLINE_BASE64_MIN_CHARS) {
    return match;
  }
  return /^image\//i.test(mime) ? MEDIA_OMITTED_TEXT.IMAGE : MEDIA_OMITTED_TEXT.FILE;
};

/**
 * Replace image and PDF data: URLs with a payload of INLINE_BASE64_MIN_CHARS
 * or more in tool-result text with a placeholder. Everything else, including
 * bare base64, hex and small or non-image data URLs, is left alone. Never throws.
 */
export function scrubInlineBase64(text) {
  if (typeof text !== "string" || text.length < INLINE_BASE64_MIN_CHARS || !text.includes("data:")) return text;
  try {
    return text.replace(DATA_URI, dataUriText);
  } catch {
    return text;
  }
}

/** URL of a Chat image_url or Responses input_image part: `image_url` is `{ url }` or a bare string. */
export function imagePartUrl(part) {
  const value = part?.image_url;
  const url = typeof value === "string" ? value : value?.url;
  return typeof url === "string" ? url : "";
}

/** True for a web (http or https) URL. */
export const isHttpUrl = (url) => typeof url === "string" && (url.startsWith("http://") || url.startsWith("https://"));

/** True for an image part whose URL is a base64 data: URL, the only kind some targets can attach. */
export const isDataUriImage = (part) => parseDataUri(imagePartUrl(part)) !== null;

const textPart = (text) => ({ type: OPENAI_BLOCK.TEXT, text });

/** Placeholder for a content part a target can't carry. */
export function omittedText(part) {
  const type = part?.type;
  if (type === OPENAI_BLOCK.IMAGE_URL || type === OPENAI_BLOCK.IMAGE || type === RESPONSES_ITEM.INPUT_IMAGE) {
    return MEDIA_OMITTED_TEXT.IMAGE;
  }
  if (type === OPENAI_BLOCK.FILE || type === RESPONSES_ITEM.INPUT_FILE) return MEDIA_OMITTED_TEXT.FILE;
  return MEDIA_OMITTED_TEXT.OTHER;
}

// An image a target can't attach: its URL when it has a web one, else a placeholder.
const uncarriedImageText = (part) => {
  const url = imagePartUrl(part);
  return isHttpUrl(url) ? imageUrlText(url) : omittedText(part);
};

/**
 * Responses input_image (or a Chat image_url) → Chat image_url. Only a URL can
 * become an image: a file_id names a file no upstream outside the OpenAI API
 * can read, so it becomes a placeholder.
 */
function responsesImageToChat(part) {
  const url = imagePartUrl(part);
  if (!url) return textPart(MEDIA_OMITTED_TEXT.IMAGE);
  return { type: OPENAI_BLOCK.IMAGE_URL, image_url: { url, detail: part.detail || part.image_url?.detail || "auto" } };
}

/** One Responses message content part → Chat. Unknown parts pass through to the target translator. */
export function responsesContentPartToChat(part) {
  if (part?.type === RESPONSES_ITEM.INPUT_TEXT || part?.type === RESPONSES_ITEM.OUTPUT_TEXT) return textPart(part.text);
  if (part?.type === RESPONSES_ITEM.INPUT_IMAGE) return responsesImageToChat(part);
  return part;
}

/**
 * A function_call_output / custom_tool_call_output `output` → Chat tool message
 * content: a string, or text and image_url parts when it has an image. String
 * and array text get the same scrub (image and PDF data: URLs only).
 */
export function responsesOutputToChatContent(output) {
  if (typeof output === "string") return scrubInlineBase64(output);
  if (!Array.isArray(output)) {
    const json = JSON.stringify(output);
    return typeof json === "string" ? scrubInlineBase64(json) : json;
  }
  const parts = [];
  for (const raw of output) {
    if (typeof raw === "string") { parts.push(textPart(scrubInlineBase64(raw))); continue; }
    if (!raw || typeof raw !== "object") continue;
    const part = raw.type === OPENAI_BLOCK.IMAGE_URL ? responsesImageToChat(raw) : responsesContentPartToChat(raw);
    if (part.type === OPENAI_BLOCK.IMAGE_URL) parts.push(part);
    else if (typeof part.text === "string") parts.push(textPart(scrubInlineBase64(part.text)));
    else parts.push(textPart(omittedText(part)));
  }
  // No image: one string, the shape every Chat upstream takes for a tool message.
  if (parts.every((part) => part.type === OPENAI_BLOCK.TEXT)) return parts.map((part) => part.text).filter(Boolean).join("\n");
  return parts;
}

const isChatImage = (part) => part?.type === OPENAI_BLOCK.IMAGE_URL && imagePartUrl(part) !== "";

const normalizeChatImage = (part) => (typeof part.image_url === "string"
  ? { ...part, image_url: { url: part.image_url } }
  : part);

// Text of Chat content parts. The nth image the target carries becomes
// imageText(n), one it doesn't uncarried(part), other media a placeholder, and
// text is scrubbed.
function partsText(parts, imageText, carries = isChatImage, uncarried = uncarriedImageText) {
  let images = 0;
  const texts = [];
  for (const part of parts) {
    if (typeof part === "string") texts.push(scrubInlineBase64(part));
    else if (!part || typeof part !== "object") continue;
    else if (isChatImage(part)) texts.push(carries(part) ? imageText(++images) : uncarried(part));
    else if (typeof part.text === "string") texts.push(scrubInlineBase64(part.text));
    else texts.push(omittedText(part));
  }
  return texts.filter(Boolean).join("\n");
}

const imageOmitted = () => MEDIA_OMITTED_TEXT.IMAGE;

/** Tool message content as plain text, for a target that takes no media in a tool result. */
export function toolContentText(content) {
  if (typeof content === "string") return scrubInlineBase64(content);
  if (Array.isArray(content)) return partsText(content, imageOmitted, () => false, imageOmitted);
  if (content == null) return "";
  try {
    return scrubInlineBase64(JSON.stringify(content)) ?? "";
  } catch {
    return "";
  }
}

/**
 * Tool message content split for a target that carries images next to the
 * result (Gemini inlineData, Kiro images): the text, with a note where each
 * carried image was, and those image parts. `offset` is how many images earlier
 * results in the same turn already attached, so the notes keep counting.
 * `carries(part)` picks the images the target can attach; the others stay as
 * their URL or a placeholder.
 */
export function splitToolContent(content, { offset = 0, carries = isChatImage } = {}) {
  if (!Array.isArray(content)) return { text: toolContentText(content), images: [] };
  return {
    text: partsText(content, (n) => imageAttachedBelowText(offset + n), carries),
    images: content.filter((part) => isChatImage(part) && carries(part)).map(normalizeChatImage),
  };
}

// The tool message with its text scrubbed, or the same object when nothing changed.
function scrubToolMessage(msg) {
  if (typeof msg.content === "string") {
    const text = scrubInlineBase64(msg.content);
    return text === msg.content ? msg : { ...msg, content: text };
  }
  if (!Array.isArray(msg.content)) return msg;
  let changed = false;
  const content = msg.content.map((part) => {
    if (typeof part?.text !== "string") return part;
    const text = scrubInlineBase64(part.text);
    if (text === part.text) return part;
    changed = true;
    return { ...part, text };
  });
  return changed ? { ...msg, content } : msg;
}

const hasToolImages = (msg) => msg?.role === ROLE.TOOL && Array.isArray(msg.content) && msg.content.some(isChatImage);

/**
 * For Chat targets. Most OpenAI-compatible upstreams take only text in a role
 * "tool" message, so each image moves to ONE user message after the run of
 * tool messages it came from. Every tool result of an assistant turn still
 * comes straight after it. Tool text is scrubbed. `carries(part)` says whether
 * the target can take an image; one it can't stays as its URL or a placeholder.
 * Returns a new array when anything changed, else `messages` itself; message
 * objects are never modified.
 */
export function moveToolImagesToUserTurn(messages, carries = isChatImage) {
  if (!Array.isArray(messages)) return messages;
  let changed = false;
  const out = [];
  let images = [];
  const flush = () => {
    if (images.length > 0) out.push({ role: ROLE.USER, content: images });
    images = [];
  };
  for (const msg of messages) {
    if (msg?.role !== ROLE.TOOL) {
      flush();
      out.push(msg);
      continue;
    }
    if (!hasToolImages(msg)) {
      const scrubbed = scrubToolMessage(msg);
      if (scrubbed !== msg) changed = true;
      out.push(scrubbed);
      continue;
    }
    changed = true;
    const offset = images.length;
    out.push({ ...msg, content: partsText(msg.content, (n) => imageAttachedBelowText(offset + n), carries) });
    images.push(...msg.content.filter((part) => isChatImage(part) && carries(part)).map(normalizeChatImage));
  }
  flush();
  return changed ? out : messages;
}
