// Keep a long computer-use session under an upstream's image limits (per
// target, in IMAGE_WINDOW): an image count, a request size, and for
// Anthropic the hi-res rule (no more than 20 images once any is over 2000 px
// on a side). The client resends the whole history every turn, so this is a
// pure function of the images in it, oldest first: a sliding window that is
// trimmed back to a target whenever it crosses a trigger. Tool-result images
// go first; when none is left to drop and the window is still over a
// trigger, user images go too, down to the target as well. When the hi-res
// rule binds, the large images go first if that clears it, else the oldest
// tool or large images. The newest image is always kept. Each trim is a
// chunk, so adding an image changes what is dropped only at a trigger, and
// the prompt prefix, and its cache, stays the same between trims.
import { ROLE, OPENAI_BLOCK, CLAUDE_BLOCK } from "../schema/index.js";
import { IMAGE_WINDOW, MEDIA_OMITTED_TEXT } from "../../config/mediaConfig.js";
import { imageDimensions, parseDataUri } from "./image.js";
import { imagePartUrl, isHttpUrl } from "./toolContent.js";

type Limit = { hard: number; trigger: number; target: number };
export type ImageLimits = {
  images?: Limit;
  base64Bytes?: Limit;
  hiRes?: { maxSide: number; trigger: number; target: number };
  countUrlImages: boolean;
};
export type ImageEntry = { tool: boolean; bytes: number; large: () => boolean };
type Rules = { images: boolean; bytes: boolean; hiRes: boolean };
// Messages and blocks are arbitrary client JSON.
type Message = Record<string, any>;
type Block = Record<string, any>;
type Found = { entry: ImageEntry; replace: () => void };

/**
 * Which images to drop. `entries` are the request's images, oldest first:
 * `tool` marks a tool-result image, `bytes` is its base64 length and
 * `large()` says whether it is over the hi-res side (or of unknown size).
 * `limits` is one IMAGE_WINDOW target.
 * @returns indexes into `entries`
 */
export function planImageWindow(entries: ImageEntry[], limits: ImageLimits = IMAGE_WINDOW.CLAUDE): Set<number> {
  const { images, base64Bytes, hiRes } = limits;
  const dropped = new Set<number>();
  const largeMemo = new Map<number, boolean>();
  const isLarge = (index: number): boolean => {
    if (!largeMemo.has(index)) largeMemo.set(index, !!entries[index].large());
    return largeMemo.get(index) as boolean;
  };
  const isTool = (index: number): boolean => entries[index].tool;
  const window: number[] = []; // indexes still sent, oldest first
  let bytes = 0;
  const overHiRes = (max: number): boolean => !!hiRes && window.length > max && window.some(isLarge);
  // Oldest window position matching `test`, never the newest image; -1 if none.
  const oldest = (test: (index: number) => boolean): number => {
    for (let pos = 0; pos < window.length - 1; pos++) if (test(window[pos])) return pos;
    return -1;
  };
  const overTrigger = (): Rules => ({
    images: !!images && window.length > images.trigger,
    bytes: !!base64Bytes && bytes > base64Bytes.trigger,
    hiRes: !!hiRes && overHiRes(hiRes.trigger),
  });
  const any = (rules: Rules): boolean => rules.images || rules.bytes || rules.hiRes;

  // Drop until every rule in `over` is back at its target. Small user images
  // only with `users`.
  const trim = (over: Rules, users: boolean): void => {
    const atTarget = () => (!over.images || window.length <= (images as Limit).target)
      && (!over.bytes || bytes <= (base64Bytes as Limit).target)
      && (!over.hiRes || !overHiRes((hiRes as { target: number }).target));
    while (!atTarget()) {
      let pos = -1;
      if (over.hiRes && hiRes && overHiRes(hiRes.target)) {
        // With a small newest image, dropping the large ones clears the rule:
        // large tool images first, then large user ones. With a large newest
        // image only the count can: the oldest tool or large images go.
        if (!isLarge(window[window.length - 1])) {
          pos = oldest((i) => isTool(i) && isLarge(i));
          if (pos < 0) pos = oldest((i) => !isTool(i) && isLarge(i));
        } else {
          pos = oldest((i) => isTool(i) || isLarge(i));
        }
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
    const triggered = overTrigger();
    if (!any(triggered)) continue;
    trim(triggered, false);
    // No tool image left to drop and still over a trigger: user images go
    // too, down to the target, so the next image doesn't trigger again.
    const still = overTrigger();
    if (any(still)) trim(still, true);
  }
  return dropped;
}

const isLargeImage = (base64: string, maxSide: number): boolean => {
  const size = base64 ? imageDimensions(base64) : null;
  return !size || size.width > maxSide || size.height > maxSide;
};

const earlierImage = (): Block => ({ type: CLAUDE_BLOCK.TEXT, text: MEDIA_OMITTED_TEXT.EARLIER_IMAGE });

// An entry for an image with this base64 (empty for a URL image).
const entryOf = (tool: boolean, base64: string, limits: ImageLimits): ImageEntry => ({
  tool,
  bytes: base64.length,
  large: () => isLargeImage(base64, limits.hiRes?.maxSide ?? Infinity),
});

// Plan over `found` and run the replacements; true when any ran.
function applyWindow(found: Found[], limits: ImageLimits): boolean {
  const dropped = planImageWindow(found.map((f) => f.entry), limits);
  for (const index of dropped) found[index].replace();
  return dropped.size > 0;
}

const copyContent = (messages: Message[]): Message[] =>
  messages.map((msg) => (Array.isArray(msg?.content) ? { ...msg, content: [...msg.content] } : msg));

/**
 * Claude-format messages: image blocks in user content and inside tool_result
 * content. Returns `messages` itself when nothing is dropped, else a copy;
 * the input is never modified.
 */
export function capClaudeImages<T>(messages: T, limits: ImageLimits = IMAGE_WINDOW.CLAUDE): T {
  if (!Array.isArray(messages)) return messages;
  const out = copyContent(messages);
  const found: Found[] = [];
  const entryFor = (block: Block, tool: boolean): ImageEntry | null => {
    const base64 = block.source?.type === "base64" && typeof block.source.data === "string" ? block.source.data : "";
    if (!base64 && !limits.countUrlImages) return null;
    return entryOf(tool, base64, limits);
  };
  out.forEach((msg) => {
    if (!Array.isArray(msg?.content)) return;
    msg.content.forEach((block: Block, i: number) => {
      if (block?.type === CLAUDE_BLOCK.IMAGE) {
        const entry = entryFor(block, false);
        if (entry) found.push({ entry, replace: () => { msg.content[i] = earlierImage(); } });
      } else if (block?.type === CLAUDE_BLOCK.TOOL_RESULT && Array.isArray(block.content)) {
        block.content.forEach((item: Block, j: number) => {
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
  return (found.length > 0 && applyWindow(found, limits) ? out : messages) as T;
}

/**
 * A Kiro conversation (history plus current message), for after session
 * replay has put the stored first turn back. Images sit in
 * `userInputMessage.images`; those on a turn carrying tool results count as
 * tool images. A dropped image leaves the placeholder in that turn's content.
 * Returns the input itself when nothing is dropped, else copies.
 */
export function capKiroImages<H, C>(
  conversation: { history: H; currentMessage: C },
  limits: ImageLimits = IMAGE_WINDOW.KIRO,
): { history: H; currentMessage: C } {
  const turns: Message[] = [...(Array.isArray(conversation.history) ? conversation.history : []), conversation.currentMessage as Message];
  const found: Found[] = [];
  const copies = new Map<number, Message>();
  // The turn's userInputMessage, copied once before its first change.
  const editable = (t: number): Message => {
    if (!copies.has(t)) {
      const input = turns[t].userInputMessage;
      copies.set(t, { ...input, images: [...input.images], content: input.content ?? "" });
    }
    return copies.get(t) as Message;
  };
  turns.forEach((turn, t) => {
    const input = turn?.userInputMessage;
    if (!Array.isArray(input?.images)) return;
    const tool = !!input.userInputMessageContext?.toolResults?.length;
    input.images.forEach((image: Block, i: number) => {
      const base64 = typeof image?.source?.bytes === "string" ? image.source.bytes : "";
      found.push({
        entry: entryOf(tool, base64, limits),
        replace: () => {
          const copy = editable(t);
          copy.images[i] = null;
          copy.content = copy.content ? `${copy.content}\n\n${MEDIA_OMITTED_TEXT.EARLIER_IMAGE}` : MEDIA_OMITTED_TEXT.EARLIER_IMAGE;
        },
      });
    });
  });
  if (found.length === 0 || !applyWindow(found, limits)) return conversation;
  const rebuilt = turns.map((turn, t) => {
    const copy = copies.get(t);
    if (!copy) return turn;
    const images = copy.images.filter(Boolean);
    const input: Message = { ...copy };
    if (images.length > 0) input.images = images;
    else delete input.images;
    return { ...turn, userInputMessage: input };
  });
  return {
    history: rebuilt.slice(0, -1) as H,
    currentMessage: rebuilt[rebuilt.length - 1] as C,
  };
}

/**
 * Chat-format messages: image_url (and Claude-shaped image) parts in user and
 * tool messages. Same contract as capClaudeImages.
 */
export function capChatImages<T>(messages: T, limits: ImageLimits = IMAGE_WINDOW.CLAUDE): T {
  if (!Array.isArray(messages)) return messages;
  const out = copyContent(messages);
  const found: Found[] = [];
  out.forEach((msg) => {
    if (!Array.isArray(msg?.content) || (msg.role !== ROLE.USER && msg.role !== ROLE.TOOL)) return;
    msg.content.forEach((part: Block, i: number) => {
      let base64: string;
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
  return (found.length > 0 && applyWindow(found, limits) ? out : messages) as T;
}
