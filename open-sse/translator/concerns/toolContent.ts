// Tool results that carry images, such as a computer-use or browser tool's
// screenshot. A Responses client sends them as an array `output`, the Chat
// pivot carries them as content parts, and each target gets them as images it
// can read, as the image's URL, or as a short placeholder.
import { ROLE, OPENAI_BLOCK, CLAUDE_BLOCK, RESPONSES_ITEM } from "../schema/index.js";
import { parseDataUri } from "./image.js";
import {
  MEDIA_OMITTED_TEXT,
  INLINE_BASE64_MIN_CHARS,
  SCRUBBED_DATA_URI_MIME,
  imageAttachedBelowText,
  imageUrlText,
} from "../../config/mediaConfig.js";

// Content parts and messages are arbitrary client JSON.
type Part = Record<string, any>;
type Message = Record<string, any>;
type TextPart = { type: string; text: string };
type ImageTest = (part: Part) => boolean;

// A data: URL, with any RFC 2397 `;name=value` parameters before `;base64`,
// in any case. It starts only at a literal "data:", and no part of it can
// match the text the next part needs, so it runs in linear time.
const DATA_URI = /data:([\w.+-]+\/[\w.+-]+)((?:;[\w.+-]+=[^;,\s]*)*);base64,[A-Za-z0-9+/=]+/gi;
const BASE64_MARKER = /;base64,/i;
const HAS_DATA_URI = /data:/i;

const dataUriText = (match: string, mime: string): string => {
  const payload = match.length - (match.search(BASE64_MARKER) + ";base64,".length);
  if (!SCRUBBED_DATA_URI_MIME.test(mime) || payload < INLINE_BASE64_MIN_CHARS) return match;
  return /^image\//i.test(mime) ? MEDIA_OMITTED_TEXT.IMAGE : MEDIA_OMITTED_TEXT.FILE;
};

/**
 * Replace image and PDF data: URLs with a payload of INLINE_BASE64_MIN_CHARS
 * or more in tool-result text with a placeholder. Everything else, including
 * bare base64, hex and small or non-image data URLs, is left alone. Never throws.
 */
export function scrubInlineBase64<T>(text: T): T {
  if (typeof text !== "string" || text.length < INLINE_BASE64_MIN_CHARS || !HAS_DATA_URI.test(text)) return text;
  try {
    return text.replace(DATA_URI, dataUriText) as unknown as T;
  } catch {
    return text;
  }
}

/** URL of a Chat image_url or Responses input_image part: `image_url` is `{ url }` or a bare string. */
export function imagePartUrl(part: Part | null | undefined): string {
  const value = part?.image_url;
  const url = typeof value === "string" ? value : value?.url;
  return typeof url === "string" ? url : "";
}

/** True for a web (http or https) URL. */
export const isHttpUrl = (url: unknown): boolean =>
  typeof url === "string" && (url.startsWith("http://") || url.startsWith("https://"));

/** True for an image part whose URL is a base64 data: URL, the only kind some targets can attach. */
export const isDataUriImage: ImageTest = (part) => parseDataUri(imagePartUrl(part)) !== null;

const textPart = (text: string): TextPart => ({ type: OPENAI_BLOCK.TEXT, text });

/** Placeholder for a content part a target can't carry. */
export function omittedText(part: Part | null | undefined): string {
  const type = part?.type;
  if (type === OPENAI_BLOCK.IMAGE_URL || type === OPENAI_BLOCK.IMAGE || type === RESPONSES_ITEM.INPUT_IMAGE) {
    return MEDIA_OMITTED_TEXT.IMAGE;
  }
  if (type === OPENAI_BLOCK.FILE || type === RESPONSES_ITEM.INPUT_FILE) return MEDIA_OMITTED_TEXT.FILE;
  return MEDIA_OMITTED_TEXT.OTHER;
}

// An image a target can't attach: its URL when it has a web one, else a placeholder.
const uncarriedImageText = (part: Part): string => {
  const url = imagePartUrl(part);
  return isHttpUrl(url) ? imageUrlText(url) : omittedText(part);
};

// Responses input_image (or a Chat image_url) → Chat image_url. Only a URL can
// become an image: a file_id names a file no upstream outside the OpenAI API
// can read, so it becomes a placeholder.
function responsesImageToChat(part: Part): Part {
  const url = imagePartUrl(part);
  if (!url) return textPart(MEDIA_OMITTED_TEXT.IMAGE);
  return { type: OPENAI_BLOCK.IMAGE_URL, image_url: { url, detail: part.detail || part.image_url?.detail || "auto" } };
}

/** One Responses message content part → Chat. Unknown parts pass through to the target translator. */
export function responsesContentPartToChat(part: Part): Part {
  if (part?.type === RESPONSES_ITEM.INPUT_TEXT || part?.type === RESPONSES_ITEM.OUTPUT_TEXT) return textPart(part.text);
  if (part?.type === RESPONSES_ITEM.INPUT_IMAGE) return responsesImageToChat(part);
  return part;
}

/**
 * A function_call_output / custom_tool_call_output `output` → Chat tool message
 * content: a string, or text and image_url parts when it has an image. String
 * and array text get the same scrub (image and PDF data: URLs only).
 */
export function responsesOutputToChatContent(output: unknown): string | Part[] | undefined {
  if (typeof output === "string") return scrubInlineBase64(output);
  if (!Array.isArray(output)) {
    const json = JSON.stringify(output);
    return typeof json === "string" ? scrubInlineBase64(json) : json;
  }
  const parts: Part[] = [];
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

const isChatImage: ImageTest = (part) => part?.type === OPENAI_BLOCK.IMAGE_URL && imagePartUrl(part) !== "";

const normalizeChatImage = (part: Part): Part => (typeof part.image_url === "string"
  ? { ...part, image_url: { url: part.image_url } }
  : part);

// Text of Chat content parts. The nth image the target carries becomes
// imageText(n), one it doesn't uncarried(part), other media a placeholder, and
// text is scrubbed.
function partsText(
  parts: unknown[],
  imageText: (n: number) => string,
  carries: ImageTest = isChatImage,
  uncarried: (part: Part) => string = uncarriedImageText,
): string {
  let images = 0;
  const texts: string[] = [];
  for (const part of parts) {
    if (typeof part === "string") texts.push(scrubInlineBase64(part));
    else if (!part || typeof part !== "object") continue;
    else if (isChatImage(part as Part)) texts.push(carries(part as Part) ? imageText(++images) : uncarried(part as Part));
    else if (typeof (part as Part).text === "string") texts.push(scrubInlineBase64((part as Part).text));
    else texts.push(omittedText(part as Part));
  }
  return texts.filter(Boolean).join("\n");
}

const imageOmitted = (): string => MEDIA_OMITTED_TEXT.IMAGE;

/** Tool message content as plain text, for a target that takes no media in a tool result. */
export function toolContentText(content: unknown): string {
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
 * result (a user turn, Gemini inlineData, Kiro images): the text, with a note
 * where each carried image was, and those image parts. `offset` is how many
 * images earlier results in the same turn already attached, so the notes keep
 * counting. `carries(part)` picks the images the target can attach; the
 * others stay as their URL or a placeholder.
 */
export function splitToolContent(
  content: unknown,
  { offset = 0, carries = isChatImage }: { offset?: number; carries?: ImageTest } = {},
): { text: string; images: Part[] } {
  if (!Array.isArray(content)) return { text: toolContentText(content), images: [] };
  return {
    text: partsText(content, (n) => imageAttachedBelowText(offset + n), carries),
    images: content.filter((part: Part) => isChatImage(part) && carries(part)).map(normalizeChatImage),
  };
}

/**
 * Text of a Claude tool_result's content blocks for a target that carries its
 * images next to the result. `attach(block)` takes an image block and returns
 * the attached image's number (1-based) or 0 when it can't attach it; that
 * image then stays as its URL or a placeholder. A document becomes a
 * placeholder; other blocks are left out.
 */
export function claudeToolResultText(blocks: unknown[], attach: (block: Part) => number): string {
  const texts: string[] = [];
  for (const block of blocks as Part[]) {
    if (block?.type === CLAUDE_BLOCK.TEXT) texts.push(block.text);
    else if (block?.type === CLAUDE_BLOCK.IMAGE) {
      const n = attach(block);
      texts.push(n > 0 ? imageAttachedBelowText(n) : block.source?.url ? imageUrlText(block.source.url) : MEDIA_OMITTED_TEXT.IMAGE);
    } else if (block?.type === CLAUDE_BLOCK.DOCUMENT) texts.push(MEDIA_OMITTED_TEXT.FILE);
  }
  return texts.filter(Boolean).join("\n");
}

// The tool message with its text scrubbed, or the same object when nothing changed.
function scrubToolMessage(msg: Message): Message {
  if (typeof msg.content === "string") {
    const text = scrubInlineBase64(msg.content);
    return text === msg.content ? msg : { ...msg, content: text };
  }
  if (!Array.isArray(msg.content)) return msg;
  let changed = false;
  const content = msg.content.map((part: Part) => {
    if (typeof part?.text !== "string") return part;
    const text = scrubInlineBase64(part.text);
    if (text === part.text) return part;
    changed = true;
    return { ...part, text };
  });
  return changed ? { ...msg, content } : msg;
}

const hasToolImages = (msg: Message): boolean =>
  msg?.role === ROLE.TOOL && Array.isArray(msg.content) && msg.content.some(isChatImage);

/**
 * For Chat targets. Most OpenAI-compatible upstreams take only text in a role
 * "tool" message, so each image moves to ONE user message after the run of
 * tool messages it came from. Every tool result of an assistant turn still
 * comes straight after it. Tool text is scrubbed. `carries(part)` says whether
 * the target can take an image; one it can't stays as its URL or a placeholder.
 * Returns a new array when anything changed, else `messages` itself; message
 * objects are never modified.
 */
export function moveToolImagesToUserTurn<T>(messages: T, carries: ImageTest = isChatImage): T {
  if (!Array.isArray(messages)) return messages;
  let changed = false;
  const out: Message[] = [];
  let images: Part[] = [];
  const flush = () => {
    if (images.length > 0) out.push({ role: ROLE.USER, content: images });
    images = [];
  };
  for (const msg of messages as Message[]) {
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
    const split = splitToolContent(msg.content, { offset: images.length, carries });
    out.push({ ...msg, content: split.text });
    images.push(...split.images);
  }
  flush();
  return (changed ? out : messages) as T;
}
