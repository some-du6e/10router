// Keep a long computer-use session under a Claude-format upstream's image
// limits (a count and a total size per request). The client sends the whole
// history every turn, so the oldest tool-result screenshots are replaced with
// a placeholder, in chunks: the same ones are dropped for many turns in a row,
// and the prompt prefix stays cacheable until the next chunk goes.
import { CLAUDE_BLOCK } from "../schema/index.js";
import { MEDIA_OMITTED_TEXT, TOOL_IMAGE_CAP } from "../../config/mediaConfig.js";

const imageBytes = (block) => (block.source?.type === "base64" && typeof block.source.data === "string"
  ? Math.floor((block.source.data.length * 3) / 4)
  : 0);

/**
 * Replace the oldest tool_result images in Claude `messages` when the request
 * is over `cap`. User-message images and the newest `cap.KEEP_RECENT` tool
 * images are never dropped. Tool_result content arrays are replaced, never
 * edited in place. Returns how many images were dropped.
 */
export function capToolResultImages(messages, cap = TOOL_IMAGE_CAP) {
  if (!Array.isArray(messages)) return 0;
  let images = 0;
  let bytes = 0;
  const toolImages = []; // { result, index, bytes }, oldest first
  for (const msg of messages) {
    if (!Array.isArray(msg?.content)) continue;
    for (const block of msg.content) {
      if (block?.type === CLAUDE_BLOCK.IMAGE) {
        images++;
        bytes += imageBytes(block);
      } else if (block?.type === CLAUDE_BLOCK.TOOL_RESULT && Array.isArray(block.content)) {
        block.content.forEach((item, index) => {
          if (item?.type !== CLAUDE_BLOCK.IMAGE) return;
          const size = imageBytes(item);
          images++;
          bytes += size;
          toolImages.push({ result: block, index, bytes: size });
        });
      }
    }
  }
  if (images <= cap.MAX_IMAGES && bytes <= cap.MAX_BYTES) return 0;

  // The fewest oldest images that bring both under the cap...
  let needed = 0;
  let left = bytes;
  while (needed < toolImages.length && (images - needed > cap.MAX_IMAGES || left > cap.MAX_BYTES)) {
    left -= toolImages[needed].bytes;
    needed++;
  }
  // ...rounded up to whole chunks, so the count only moves every CHUNK turns.
  const drop = Math.min(Math.ceil(needed / cap.CHUNK) * cap.CHUNK, Math.max(0, toolImages.length - cap.KEEP_RECENT));

  const copied = new Set();
  for (const { result, index } of toolImages.slice(0, drop)) {
    if (!copied.has(result)) {
      result.content = [...result.content];
      copied.add(result);
    }
    result.content[index] = { type: CLAUDE_BLOCK.TEXT, text: MEDIA_OMITTED_TEXT.EARLIER_IMAGE };
  }
  return drop;
}
