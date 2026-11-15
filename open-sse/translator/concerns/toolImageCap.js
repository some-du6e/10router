// Keep a long computer-use session under an upstream's image limits (per
// target, in IMAGE_WINDOW): an image count, a request size, and for
// Anthropic the hi-res rule (no more than 20 images once any is over 2000 px
// on a side). The client resends the whole history every turn, so this is a
// pure function of the images in it, oldest first: a sliding window that is
// trimmed back to a target whenever it crosses a trigger. Tool-result images
// go first. User images go when the window is over a hard limit with no tool
// image left to drop, and then down to the target as well; when the hi-res
// rule binds, the large images go first, user ones included. The newest
// image is always kept. Each trim is a chunk, so adding an image changes what
// is dropped only at a trigger, and the prompt prefix, and its cache, stays
// the same between trims.
import { ROLE, OPENAI_BLOCK, CLAUDE_BLOCK } from "../schema/index.js";
import { IMAGE_WINDOW, MEDIA_OMITTED_TEXT } from "../../config/mediaConfig.js";
import { imageDimensions, parseDataUri } from "./image.js";
import { imagePartUrl, isHttpUrl } from "./toolContent.js";

/**
 * Which images to drop. `entries` are the request's images, oldest first:
 * `{ tool, bytes, large }`, where `tool` marks a tool-result image, `bytes`
 * is its base64 length and `large()` says whether it is over the hi-res side
 * (or of unknown size). `limits` is one IMAGE_WINDOW target.
 * @returns {Set<number>} indexes into `entries`
 */
export function planImageWindow(entries, limits = IMAGE_WINDOW.CLAUDE) {
  const { images, base64Bytes, hiRes } = limits;
  const dropped = new Set();
  const largeMemo = new Map();
  const isLarge = (index) => {
    if (!largeMemo.has(index)) largeMemo.set(index, !!entries[index].large());
    return largeMemo.get(index);
  };
  const window = []; // indexes still sent, oldest first
  let bytes = 0;
  const overHiRes = (max) => !!hiRes && window.length > max && window.some(isLarge);
  // Oldest window position matching `test`, never the newest image; -1 if none.
  const oldest = (test) => {
    for (let pos = 0; pos < window.length - 1; pos++) if (test(window[pos])) return pos;
    return -1;
  };
  const isTool = (index) => entries[index].tool;

  // Drop until every rule in `over` is back at its target. User images only
  // with `users`, except the large ones when the hi-res rule binds.
  const trim = (over, users) => {
    const atTarget = () => (!over.images || window.length <= images.target)
      && (!over.bytes || bytes <= base64Bytes.target)
      && (!over.hiRes || !overHiRes(hiRes.target));
    while (!atTarget()) {
      let pos = -1;
      if (over.hiRes && overHiRes(hiRes.target)) {
        pos = oldest((i) => isTool(i) && isLarge(i));
        if (pos < 0) pos = oldest((i) => !isTool(i) && isLarge(i));
      }
      if (pos < 0) pos = oldest(isTool);
      if (pos < 0 && users) pos = oldest(() => true);
      if (pos < 0) return;
      const [index] = window.splice(pos, 1);
      bytes -= entries[index].bytes;
      dropped.add(index);
    }
  };

  for (let i = 0; i < entries.length; i++) {
    window.push(i);
    bytes += entries[i].bytes;
    const triggered = {
      images: !!images && window.length > images.trigger,
      bytes: !!base64Bytes && bytes > base64Bytes.trigger,
      hiRes: overHiRes(hiRes?.trigger),
    };
    if (triggered.images || triggered.bytes || triggered.hiRes) trim(triggered, false);
    // Last resort: still over a hard limit with no tool image left to drop.
    const hard = {
      images: !!images && window.length > images.hard,
      bytes: !!base64Bytes && bytes > base64Bytes.hard,
      hiRes: overHiRes(hiRes?.trigger),
    };
    if (hard.images || hard.bytes || hard.hiRes) trim(hard, true);
  }
  return dropped;
}

const isLargeImage = (base64, maxSide) => {
  const size = base64 ? imageDimensions(base64) : null;
  return !size || size.width > maxSide || size.height > maxSide;
};

const earlierImage = () => ({ type: CLAUDE_BLOCK.TEXT, text: MEDIA_OMITTED_TEXT.EARLIER_IMAGE });

// An entry for an image with this base64 (empty for a URL image).
const entryOf = (tool, base64, limits) => ({
  tool,
  bytes: base64.length,
  large: () => isLargeImage(base64, limits.hiRes?.maxSide ?? Infinity),
});

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
export function capClaudeImages(messages, limits = IMAGE_WINDOW.CLAUDE) {
  if (!Array.isArray(messages)) return messages;
  const out = messages.map((msg) => (Array.isArray(msg?.content) ? { ...msg, content: [...msg.content] } : msg));
  const found = [];
  const entryFor = (block, tool) => {
    const base64 = block.source?.type === "base64" && typeof block.source.data === "string" ? block.source.data : "";
    if (!base64 && !limits.countUrlImages) return null;
    return entryOf(tool, base64, limits);
  };
  out.forEach((msg) => {
    if (!Array.isArray(msg?.content)) return;
    msg.content.forEach((block, i) => {
      if (block?.type === CLAUDE_BLOCK.IMAGE) {
        const entry = entryFor(block, false);
        if (entry) found.push({ entry, replace: () => { msg.content[i] = earlierImage(); } });
      } else if (block?.type === CLAUDE_BLOCK.TOOL_RESULT && Array.isArray(block.content)) {
        block.content.forEach((item, j) => {
          if (item?.type !== CLAUDE_BLOCK.IMAGE) return;
          const entry = entryFor(item, true);
          if (!entry) return;
          found.push({
            entry,
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
export function capChatImages(messages, limits = IMAGE_WINDOW.CLAUDE) {
  if (!Array.isArray(messages)) return messages;
  const out = messages.map((msg) => (Array.isArray(msg?.content) ? { ...msg, content: [...msg.content] } : msg));
  const found = [];
  out.forEach((msg) => {
    if (!Array.isArray(msg?.content) || (msg.role !== ROLE.USER && msg.role !== ROLE.TOOL)) return;
    msg.content.forEach((part, i) => {
      let base64;
      if (part?.type === OPENAI_BLOCK.IMAGE_URL) {
        const url = imagePartUrl(part);
        if (!url) return;
        base64 = parseDataUri(url)?.base64 ?? "";
        if (!base64 && (!limits.countUrlImages || !isHttpUrl(url))) return;
      } else if (part?.type === OPENAI_BLOCK.IMAGE && part.source) {
        base64 = part.source.type === "base64" && typeof part.source.data === "string" ? part.source.data : "";
        if (!base64 && !limits.countUrlImages) return;
      } else {
        return;
      }
      found.push({
        entry: entryOf(msg.role === ROLE.TOOL, base64, limits),
        replace: () => { msg.content[i] = earlierImage(); },
      });
    });
  });
  return found.length > 0 && applyWindow(found, limits) ? out : messages;
}
