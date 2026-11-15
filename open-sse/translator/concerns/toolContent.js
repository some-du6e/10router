// Tool results that carry images, such as a computer-use or browser tool's
// screenshot. A Responses client sends them as an array `output`, the Chat
// pivot carries them as content parts, and each target gets them as images it
// can read, or as a short placeholder. Base64 never goes upstream as text.
import { ROLE, OPENAI_BLOCK, RESPONSES_ITEM } from "../schema/index.js";
import { MEDIA_OMITTED_TEXT, INLINE_BASE64_MIN_CHARS, imageAttachedBelowText } from "../../config/mediaConfig.js";

const INLINE_BASE64 = new RegExp(
  `(data:[\\w.+-]+/[\\w.+-]+;base64,)?[A-Za-z0-9+/]{${INLINE_BASE64_MIN_CHARS},}={0,2}`,
  "g",
);
const IMAGE_DATA_URI = /^data:image\//i;

const blobText = (match, dataUri) => {
  if (!dataUri) return MEDIA_OMITTED_TEXT.OTHER;
  return IMAGE_DATA_URI.test(dataUri) ? MEDIA_OMITTED_TEXT.IMAGE : MEDIA_OMITTED_TEXT.FILE;
};

/** Replace data: URLs and long base64 runs in tool-result text with a placeholder. Never throws. */
export function scrubInlineBase64(text) {
  if (typeof text !== "string" || text.length < INLINE_BASE64_MIN_CHARS) return text;
  try {
    return text.replace(INLINE_BASE64, blobText);
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

/**
 * Responses input_image (or a Chat image_url) → Chat image_url. Only a URL can
 * become an image: a file_id names a file no upstream outside the OpenAI API
 * can read, so it becomes a placeholder.
 */
export function responsesImageToChat(part) {
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
 * content. A string stays as it is. An array becomes text and image_url parts.
 */
export function responsesOutputToChatContent(output) {
  if (typeof output === "string") return output;
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
  return parts.length > 0 ? parts : "";
}

const isChatImage = (part) => part?.type === OPENAI_BLOCK.IMAGE_URL && imagePartUrl(part) !== "";

const normalizeChatImage = (part) => (typeof part.image_url === "string"
  ? { ...part, image_url: { url: part.image_url } }
  : part);

// Text of Chat content parts. The nth image becomes imageText(n), other media a
// placeholder, and text is scrubbed of inline base64.
function partsText(parts, imageText) {
  let images = 0;
  const texts = [];
  for (const part of parts) {
    if (typeof part === "string") texts.push(scrubInlineBase64(part));
    else if (!part || typeof part !== "object") continue;
    else if (isChatImage(part)) texts.push(imageText(++images));
    else if (typeof part.text === "string") texts.push(scrubInlineBase64(part.text));
    else texts.push(omittedText(part));
  }
  return texts.filter(Boolean).join("\n");
}

/** Tool message content as plain text, for a target that takes no media in a tool result. */
export function toolContentText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return partsText(content, () => MEDIA_OMITTED_TEXT.IMAGE);
  if (content == null) return "";
  try {
    return scrubInlineBase64(JSON.stringify(content)) ?? "";
  } catch {
    return "";
  }
}

/**
 * Tool message content split for a target that carries images next to the
 * result (a user turn, Gemini inlineData, Kiro images): the text, with a note
 * where each image was, and the image parts.
 */
export function splitToolContent(content) {
  if (!Array.isArray(content)) return { text: toolContentText(content), images: [] };
  return {
    text: partsText(content, imageAttachedBelowText),
    images: content.filter(isChatImage).map(normalizeChatImage),
  };
}

const hasToolImages = (msg) => msg?.role === ROLE.TOOL && Array.isArray(msg.content) && msg.content.some(isChatImage);

/**
 * For Chat targets. Most OpenAI-compatible upstreams take only text in a role
 * "tool" message, so each image moves to ONE user message after the run of
 * tool messages it came from. Every tool result of an assistant turn still
 * comes straight after it. Messages without tool images are returned as they are.
 */
export function moveToolImagesToUserTurn(messages) {
  if (!Array.isArray(messages) || !messages.some(hasToolImages)) return messages;
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
      out.push(msg);
      continue;
    }
    const offset = images.length;
    out.push({ ...msg, content: partsText(msg.content, (n) => imageAttachedBelowText(offset + n)) });
    images.push(...msg.content.filter(isChatImage).map(normalizeChatImage));
  }
  flush();
  return out;
}
