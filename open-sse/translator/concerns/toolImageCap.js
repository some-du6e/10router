// Keep a long computer-use session under an upstream's image limits: an
// image count, a request size, and the hi-res rule (no more than 20 images
// once any is over 2000 px on a side). The client resends the whole history
// every turn, so this is a pure function of the images in it, oldest first:
// a sliding window that is trimmed back to a target whenever it crosses a
// trigger. Adding an image changes what is dropped only at those crossings,
// so the prompt prefix, and its cache, stays the same between trims.
import { ROLE, OPENAI_BLOCK, CLAUDE_BLOCK } from "../schema/index.js";
import { IMAGE_WINDOW, MEDIA_OMITTED_TEXT } from "../../config/mediaConfig.js";
import { imageDimensions, parseDataUri } from "./image.js";
import { imagePartUrl } from "./toolContent.js";

/**
 * Which images to drop. `entries` are the request's images, oldest first:
 * `{ tool, bytes, large }`, where `tool` marks a tool-result image, `bytes`
 * is its base64 length and `large()` says whether it is over the hi-res side
 * (or of unknown size). Tool images go first; user images only when the window
 * is still over a hard limit without them. The newest image is always kept.
 * @returns {Set<number>} indexes into `entries`
 */
export function planImageWindow(entries, limits = IMAGE_WINDOW) {
  const dropped = new Set();
  const largeMemo = new Map();
  const isLarge = (index) => {
    if (!largeMemo.has(index)) largeMemo.set(index, !!entries[index].large());
    return largeMemo.get(index);
  };
  const window = []; // indexes still sent, oldest first
  let bytes = 0;
  const remove = (pos) => {
    const [index] = window.splice(pos, 1);
    bytes -= entries[index].bytes;
    dropped.add(index);
  };
  const overHiRes = (max) => window.length > max && window.some(isLarge);

  for (let i = 0; i < entries.length; i++) {
    window.push(i);
    bytes += entries[i].bytes;

    const count = window.length > limits.TRIGGER_IMAGES;
    const size = bytes > limits.TRIGGER_BASE64_BYTES;
    const hiRes = overHiRes(limits.HI_RES_TRIGGER_IMAGES);
    if (count || size || hiRes) {
      const atTarget = () => (!count || window.length <= limits.TARGET_IMAGES)
        && (!size || bytes <= limits.TARGET_BASE64_BYTES)
        && (!hiRes || !overHiRes(limits.HI_RES_TARGET_IMAGES));
      let pos = 0;
      while (!atTarget()) {
        while (pos < window.length - 1 && !entries[window[pos]].tool) pos++;
        if (pos >= window.length - 1) break; // no older tool image left
        remove(pos);
      }
    }

    // Last resort: user images too, oldest first, until under the hard limits.
    while (window.length > 1 && (window.length > limits.HARD_MAX_IMAGES
      || bytes > limits.HARD_MAX_BASE64_BYTES
      || overHiRes(limits.HI_RES_TRIGGER_IMAGES))) {
      remove(0);
    }
  }
  return dropped;
}

const isLargeImage = (base64, maxSide) => {
  const size = base64 ? imageDimensions(base64) : null;
  return !size || size.width > maxSide || size.height > maxSide;
};

const earlierImage = () => ({ type: CLAUDE_BLOCK.TEXT, text: MEDIA_OMITTED_TEXT.EARLIER_IMAGE });

// Plan over `found` ({ entry, replace }) and run the replacements; true when any ran.
function applyWindow(found, limits) {
  const dropped = planImageWindow(found.map((f) => f.entry), limits);
  for (const index of dropped) found[index].replace();
  return dropped.size > 0;
}

/**
 * Claude-format messages: image blocks in user content and inside tool_result
 * content. Returns `messages` itself when nothing is dropped, else a copy;
 * the input is never modified.
 */
export function capClaudeImages(messages, limits = IMAGE_WINDOW) {
  if (!Array.isArray(messages)) return messages;
  const out = messages.map((msg) => (Array.isArray(msg?.content) ? { ...msg, content: [...msg.content] } : msg));
  const found = [];
  const entryFor = (block, tool) => {
    const base64 = block.source?.type === "base64" && typeof block.source.data === "string" ? block.source.data : "";
    return { tool, bytes: base64.length, large: () => isLargeImage(base64, limits.HI_RES_MAX_SIDE) };
  };
  out.forEach((msg) => {
    if (!Array.isArray(msg?.content)) return;
    msg.content.forEach((block, i) => {
      if (block?.type === CLAUDE_BLOCK.IMAGE) {
        found.push({ entry: entryFor(block, false), replace: () => { msg.content[i] = earlierImage(); } });
      } else if (block?.type === CLAUDE_BLOCK.TOOL_RESULT && Array.isArray(block.content)) {
        block.content.forEach((item, j) => {
          if (item?.type !== CLAUDE_BLOCK.IMAGE) return;
          found.push({
            entry: entryFor(item, true),
            replace: () => {
              const current = msg.content[i];
              const content = [...current.content];
              content[j] = earlierImage();
              msg.content[i] = { ...current, content };
            },
          });
        });
      }
    });
  });
  return found.length > 0 && applyWindow(found, limits) ? out : messages;
}

/**
 * Chat-format messages: image_url (and Claude-shaped image) parts in user and
 * tool messages. Same contract as capClaudeImages.
 */
export function capChatImages(messages, limits = IMAGE_WINDOW) {
  if (!Array.isArray(messages)) return messages;
  const out = messages.map((msg) => (Array.isArray(msg?.content) ? { ...msg, content: [...msg.content] } : msg));
  const found = [];
  out.forEach((msg) => {
    if (!Array.isArray(msg?.content) || (msg.role !== ROLE.USER && msg.role !== ROLE.TOOL)) return;
    msg.content.forEach((part, i) => {
      let base64 = "";
      let bytes = 0;
      if (part?.type === OPENAI_BLOCK.IMAGE_URL) {
        const url = imagePartUrl(part);
        if (!url) return;
        base64 = parseDataUri(url)?.base64 ?? "";
        bytes = base64.length;
      } else if (part?.type === OPENAI_BLOCK.IMAGE && part.source) {
        base64 = part.source.type === "base64" && typeof part.source.data === "string" ? part.source.data : "";
        bytes = base64.length;
      } else {
        return;
      }
      found.push({
        entry: { tool: msg.role === ROLE.TOOL, bytes, large: () => isLargeImage(base64, limits.HI_RES_MAX_SIDE) },
        replace: () => { msg.content[i] = earlierImage(); },
      });
    });
  });
  return found.length > 0 && applyWindow(found, limits) ? out : messages;
}
