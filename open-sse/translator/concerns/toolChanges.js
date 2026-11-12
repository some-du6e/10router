// Mid-conversation tool changes: Claude Code puts tool_addition / tool_removal
// blocks in a role "system" message inside messages[]. Upstreams without the
// beta reject the block type, so the change is folded into the up-front tools[]
// instead, which the model reads the same way.
import { ROLE, CLAUDE_BLOCK, CLAUDE_TOOL_REF } from "../schema/index.js";
import { claudeContinuationContent } from "./message.js";

export const isToolChangeBlock = (block) =>
  block?.type === CLAUDE_BLOCK.TOOL_ADDITION || block?.type === CLAUDE_BLOCK.TOOL_REMOVAL;

export function hasToolChanges(body) {
  return Array.isArray(body?.messages)
    && body.messages.some((msg) => Array.isArray(msg?.content) && msg.content.some(isToolChangeBlock));
}

const isByValue = (block) => block?.type === CLAUDE_BLOCK.TOOL_ADDITION && block.tool?.type === CLAUDE_TOOL_REF.DEFINITION;

// A tools[] entry: a plain object with a name (or an OpenAI-style function
// name, which the tools step folds). Anything else is dropped.
const toolName = (def) => (typeof def.name === "string" ? def.name : def.function?.name);
const isToolDefinition = (def) => {
  if (!def || typeof def !== "object" || Array.isArray(def)) return false;
  const name = toolName(def);
  return typeof name === "string" && name !== "";
};

// A copy of body with each by-value definition replaced by fn(definition), so
// it goes out shaped like the tools[] entries beside it. A malformed
// definition, or one fn returns null for, takes its block with it (folded out
// like a block without its beta). The same body when there are none.
export function mapToolDefinitions(body, fn) {
  if (!hasToolChanges(body) || !body.messages.some((m) => Array.isArray(m?.content) && m.content.some(isByValue))) return body;
  const dropped = new Set();
  const messages = body.messages.map((msg) => {
    if (!Array.isArray(msg?.content) || !msg.content.some(isByValue)) return msg;
    const content = msg.content.map((block) => {
      if (!isByValue(block)) return block;
      const def = isToolDefinition(block.tool.definition) ? fn(block.tool.definition) : null;
      const next = { ...block, tool: { ...block.tool, definition: def } };
      if (!isToolDefinition(def)) dropped.add(next);
      return next;
    });
    return { ...msg, content };
  });
  return inlineToolChanges({ ...body, messages }, (block) => !dropped.has(block));
}

// Apply one tool_addition to `tools` (the caller's own copy).
// By reference: the tool is already declared with defer_loading; un-defer it.
// Other deferred tools stay deferred (the upstream may still do tool search).
// By value: the inline definition is the one the client wants from now on, so
// it replaces a declared tool of the same name (keeping that tool's cache
// breakpoint), or is appended (without one of its own, so the request keeps
// the breakpoints it had).
function applyAddition(tools, tool) {
  if (tool?.type === CLAUDE_TOOL_REF.REFERENCE) {
    const i = tools.findIndex((t) => t?.name === tool.name && t.defer_loading === true);
    if (i >= 0) {
      const { defer_loading: _deferred, ...visible } = tools[i];
      tools[i] = visible;
    }
    return;
  }
  const def = tool?.type === CLAUDE_TOOL_REF.DEFINITION ? tool.definition : null;
  if (!isToolDefinition(def)) return;
  const { cache_control: _own, ...entry } = def;
  const i = tools.findIndex((t) => t?.name === toolName(def));
  if (i < 0) tools.push(entry);
  else tools[i] = tools[i]?.cache_control ? { ...entry, cache_control: tools[i].cache_control } : entry;
}

function asBlocks(content) {
  if (typeof content === "string") return content.trim() ? [{ type: CLAUDE_BLOCK.TEXT, text: content }] : [];
  return Array.isArray(content) ? content : [];
}

const takesCacheControl = (block) => block && typeof block === "object"
  && block.type !== CLAUDE_BLOCK.THINKING && block.type !== CLAUDE_BLOCK.REDACTED_THINKING && !isToolChangeBlock(block);

// A copy of msg with cacheControl on its last block that can take one; msg
// itself when it already has a breakpoint or no block can take it.
function withCacheControl(msg, cacheControl) {
  const content = asBlocks(msg.content);
  if (content.some((b) => b?.cache_control)) return msg;
  for (let i = content.length - 1; i >= 0; i--) {
    if (!takesCacheControl(content[i])) continue;
    const next = [...content];
    next[i] = { ...content[i], cache_control: cacheControl };
    return { ...msg, content: next };
  }
  return msg;
}

// A copy of body with every tool change that `keep(block)` doesn't keep taken
// out of its message and applied to tools[]; the same body when nothing changes.
// A tool_removal leaves the tool declared: earlier turns may hold tool_use
// blocks for it, and an upstream can reject those once the tool is gone.
// A message left empty is dropped; if that puts two same-role messages side by
// side they are merged, and if it leaves an assistant turn last a user turn
// follows (an interrupted tool_result per dangling tool_use, else "Continue.")
// so the request doesn't become a prefill. A cache breakpoint on a removed
// block moves to the last kept message, so the cached prefix stays the same.
/** @param {(block: any) => boolean} [keep] */
export function inlineToolChanges(body, keep = () => false) {
  if (!body || typeof body !== "object" || !hasToolChanges(body)) return body;
  const tools = Array.isArray(body.tools) ? [...body.tools] : [];
  const messages = [];
  let changed = false;
  let dropped = false;
  let cacheControl = null;
  for (const msg of body.messages) {
    let next = msg;
    if (Array.isArray(msg?.content) && msg.content.some(isToolChangeBlock)) {
      const content = [];
      for (const block of msg.content) {
        if (!isToolChangeBlock(block) || keep(block)) {
          content.push(block);
          continue;
        }
        if (block.cache_control) cacheControl ||= block.cache_control;
        if (block.type === CLAUDE_BLOCK.TOOL_ADDITION) applyAddition(tools, block.tool);
      }
      if (content.length !== msg.content.length) {
        changed = true;
        next = content.length ? { ...msg, content } : null;
      }
    }
    if (next) {
      const prev = messages[messages.length - 1];
      if (dropped && prev?.role === next.role) {
        messages[messages.length - 1] = { ...prev, content: [...asBlocks(prev.content), ...asBlocks(next.content)] };
      } else {
        messages.push(next);
      }
      dropped = false;
    } else {
      dropped = true;
    }
    if (cacheControl && messages.length) {
      messages[messages.length - 1] = withCacheControl(messages[messages.length - 1], cacheControl);
      cacheControl = null;
    }
  }
  if (!changed) return body;
  const last = messages[messages.length - 1];
  if (dropped && last?.role === ROLE.ASSISTANT) {
    messages.push({ role: ROLE.USER, content: claudeContinuationContent(last) });
  }
  const out = { ...body, messages };
  if (tools.length || Array.isArray(body.tools)) out.tools = tools;
  return out;
}
