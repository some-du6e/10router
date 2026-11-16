// Strip multimodal content blocks a model cannot read, BEFORE translation.
// Driven by getCapabilitiesForModel: vision/audioInput/pdf. Replaces removed
// media with a short text placeholder so messages never become empty.
//
// Copy-on-write: only the body's own top-level keys are reassigned. Messages,
// content arrays and blocks are the client's (the next combo model or account
// reuses them), so a changed one is replaced by a new object, never edited.
import { FORMATS } from "../formats.js";
import { CLAUDE_BLOCK, OPENAI_BLOCK, RESPONSES_ITEM } from "../schema/index.js";

// Placeholder text inserted where a media block was removed.
// Current turn: explain the active model can't read what the user just sent.
const PLACEHOLDER_CURRENT = {
  vision: "[image omitted: model has no vision support]",
  audioInput: "[audio omitted: model has no audio support]",
  pdf: "[file omitted: model has no document support]",
};
// Earlier turns: neutral (a combo may route to a different model each turn).
const PLACEHOLDER_PREV = {
  vision: "[Previous image omitted from context.]",
  audioInput: "[Previous audio omitted from context.]",
  pdf: "[Previous file omitted from context.]",
};
const ph = (cap, isLast) => (isLast ? PLACEHOLDER_CURRENT : PLACEHOLDER_PREV)[cap];

// Map gemini inlineData/fileData mime prefix -> capability it requires.
function capForMime(mime) {
  if (typeof mime !== "string") return null;
  if (mime.startsWith("image/")) return "vision";
  if (mime.startsWith("audio/")) return "audioInput";
  if (mime === "application/pdf") return "pdf";
  return null;
}

// OpenAI chat content block -> required capability (null = plain text/other, keep).
function capForOpenAIBlock(block) {
  const t = block?.type;
  if (t === "image_url" || t === "image") return "vision";
  if (t === "input_audio" || t === "audio_url") return "audioInput";
  if (t === "file") return "pdf";
  return null;
}

// Claude content block -> required capability.
function capForClaudeBlock(block) {
  const t = block?.type;
  if (t === "image") return "vision";
  if (t === "document") return "pdf";
  return null;
}

// Filter an array of content blocks; drop unsupported, add one placeholder per
// kind (built by `placeholder(text)`). isLast = block belongs to the current
// user turn (picks the explanatory placeholder). Returns `blocks` itself when
// nothing was dropped.
function filterBlocks(blocks, capOf, caps, isLast, placeholder = (text) => ({ type: "text", text })) {
  const removed = new Set();
  const out = blocks.filter((block) => {
    const cap = capOf(block);
    if (cap && caps[cap] === false) { removed.add(cap); return false; }
    return true;
  });
  if (removed.size === 0) return blocks;
  for (const cap of removed) out.push(placeholder(ph(cap, isLast)));
  return out;
}

// Map an array, returning the same array when no element changed.
function mapKeep(items, fn) {
  let out = null;
  items.forEach((item, i) => {
    const next = fn(item, i);
    if (next !== item) (out ??= items.slice())[i] = next;
  });
  return out || items;
}

// A copy of obj with the given keys replaced; obj itself when none changed.
function withChanges(obj, changes) {
  const keys = Object.keys(changes).filter((key) => changes[key] !== obj[key]);
  if (keys.length === 0) return obj;
  const copy = { ...obj };
  for (const key of keys) {
    if (changes[key] === undefined) delete copy[key];
    else copy[key] = changes[key];
  }
  return copy;
}

const isImageAttachment = (a) => a?.contentType?.startsWith("image/") || (typeof a?.url === "string" && a.url.startsWith("data:image/"));
const withoutImages = (list) => {
  const kept = list.filter((a) => !isImageAttachment(a));
  return kept.length === list.length ? list : kept;
};

// OpenAI / OpenAI-compatible chat messages[].content[].
function stripOpenAI(body, caps) {
  if (!Array.isArray(body.messages)) return;
  const last = body.messages.length - 1;
  body.messages = mapKeep(body.messages, (msg, i) => {
    if (!msg || typeof msg !== "object") return msg;
    const changes = {};
    if (caps.vision === false) {
      if (Array.isArray(msg.images)) changes.images = undefined;
      if (Array.isArray(msg.experimental_attachments)) changes.experimental_attachments = withoutImages(msg.experimental_attachments);
      if (Array.isArray(msg.attachments)) changes.attachments = withoutImages(msg.attachments);
    }
    if (Array.isArray(msg.content)) changes.content = filterBlocks(msg.content, capForOpenAIBlock, caps, i === last);
    return withChanges(msg, changes);
  });
}

// Claude messages[].content[].
function stripClaude(body, caps) {
  if (!Array.isArray(body.messages)) return;
  const last = body.messages.length - 1;
  body.messages = mapKeep(body.messages, (msg, i) => {
    if (!Array.isArray(msg?.content)) return msg;
    // Images inside a tool_result too, such as a tool's screenshot.
    const content = mapKeep(msg.content, (block) => {
      if (block?.type !== CLAUDE_BLOCK.TOOL_RESULT || !Array.isArray(block.content)) return block;
      return withChanges(block, { content: filterBlocks(block.content, capForClaudeBlock, caps, i === last) });
    });
    return withChanges(msg, { content: filterBlocks(content, capForClaudeBlock, caps, i === last) });
  });
}

// OpenAI Responses input[].content[] and a tool call's array output[] (input_image / input_file).
// A tool output may also carry Chat-shaped image_url parts, which the converter keeps.
function capForResponsesPart(block) {
  const t = block?.type;
  if (t === RESPONSES_ITEM.INPUT_IMAGE || t === OPENAI_BLOCK.IMAGE_URL) return "vision";
  if (t === RESPONSES_ITEM.INPUT_FILE) return "pdf";
  return null;
}

const responsesText = (text) => ({ type: RESPONSES_ITEM.INPUT_TEXT, text });

function stripResponses(body, caps) {
  if (!Array.isArray(body.input)) return;
  const last = body.input.length - 1;
  body.input = mapKeep(body.input, (item, i) => {
    if (!item || typeof item !== "object") return item;
    const changes = {};
    if (Array.isArray(item.content)) changes.content = filterBlocks(item.content, capForResponsesPart, caps, i === last, responsesText);
    if (Array.isArray(item.output)) changes.output = filterBlocks(item.output, capForResponsesPart, caps, i === last, responsesText);
    return withChanges(item, changes);
  });
}

// Gemini / gemini-cli contents[].parts[] (inlineData / fileData by mime).
const capForGeminiPart = (p) => capForMime(p?.inlineData?.mimeType || p?.fileData?.mimeType);
const geminiText = (text) => ({ text });

function stripGeminiParts(contents, caps) {
  if (!Array.isArray(contents)) return contents;
  const last = contents.length - 1;
  return mapKeep(contents, (c, i) => {
    if (!Array.isArray(c?.parts)) return c;
    return withChanges(c, { parts: filterBlocks(c.parts, capForGeminiPart, caps, i === last, geminiText) });
  });
}

/**
 * Remove media blocks the model can't read from the source-format body. Only
 * body's own keys are reassigned; the messages and blocks it holds are not edited.
 * @param {object} body - request body (source format)
 * @param {string} sourceFormat - one of FORMATS
 * @param {object} caps - capabilities from getCapabilitiesForModel
 * @returns {boolean} true if anything was stripped-eligible (cap false for some modality)
 */
export function stripUnsupportedModalities(body, sourceFormat, caps) {
  if (!body || !caps) return false;
  // Fast exit: model supports everything we'd strip.
  if (caps.vision !== false && caps.audioInput !== false && caps.pdf !== false) return false;

  switch (sourceFormat) {
    case FORMATS.OPENAI:
    case FORMATS.OLLAMA:
    case FORMATS.KIRO:
    case FORMATS.CURSOR:
    case FORMATS.COMMANDCODE:
      stripOpenAI(body, caps);
      break;
    case FORMATS.CLAUDE:
      stripClaude(body, caps);
      break;
    case FORMATS.OPENAI_RESPONSES:
    case FORMATS.OPENAI_RESPONSE:
    case FORMATS.CODEX:
      stripResponses(body, caps);
      break;
    case FORMATS.GEMINI:
    case FORMATS.GEMINI_CLI:
    case FORMATS.VERTEX:
      if (Array.isArray(body.contents)) body.contents = stripGeminiParts(body.contents, caps);
      break;
    case FORMATS.ANTIGRAVITY:
      if (Array.isArray(body.request?.contents)) {
        const contents = stripGeminiParts(body.request.contents, caps);
        if (contents !== body.request.contents) body.request = { ...body.request, contents };
      }
      break;
    default:
      stripOpenAI(body, caps);
  }
  return true;
}
