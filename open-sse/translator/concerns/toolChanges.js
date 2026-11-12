// Mid-conversation tool changes: Claude Code puts tool_addition / tool_removal
// blocks in a role "system" message inside messages[]. Upstreams without the
// beta reject the block type, so the change is folded into the up-front tools[]
// instead, which the model reads the same way.
import { ROLE, CLAUDE_BLOCK, CLAUDE_TOOL_REF } from "../schema/index.js";
import { CLAUDE_PREFILL_CONTINUATION_TEXT } from "../../config/claudeMessageCompat.js";

export const isToolChangeBlock = (block) =>
  block?.type === CLAUDE_BLOCK.TOOL_ADDITION || block?.type === CLAUDE_BLOCK.TOOL_REMOVAL;

export function hasToolChanges(body) {
  return Array.isArray(body?.messages)
    && body.messages.some((msg) => Array.isArray(msg?.content) && msg.content.some(isToolChangeBlock));
}

// Apply one tool_addition to `tools` (the caller's own copy).
// By reference: the tool is already declared with defer_loading; un-defer it.
// Other deferred tools stay deferred (the upstream may still do tool search).
// By value: the inline definition is the one the client wants from now on, so
// it replaces a declared tool of the same name, or is appended.
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
  if (!def || typeof def !== "object") return;
  const i = def.name == null ? -1 : tools.findIndex((t) => t?.name === def.name);
  if (i >= 0) tools[i] = def;
  else tools.push(def);
}

function asBlocks(content) {
  if (typeof content === "string") return content.trim() ? [{ type: CLAUDE_BLOCK.TEXT, text: content }] : [];
  return Array.isArray(content) ? content : [];
}

// A copy of body with every tool change that `keep(block)` doesn't keep taken
// out of its message and applied to tools[]; the same body when nothing changes.
// A tool_removal leaves the tool declared: earlier turns may hold tool_use
// blocks for it, and an upstream can reject those once the tool is gone.
// A message left empty is dropped; if that puts two same-role messages side by
// side they are merged, and if it leaves an assistant turn last a user
// "Continue." is added so the request doesn't become a prefill.
export function inlineToolChanges(body, keep = () => false) {
  if (!body || typeof body !== "object" || !hasToolChanges(body)) return body;
  const tools = Array.isArray(body.tools) ? [...body.tools] : [];
  const messages = [];
  let changed = false;
  let dropped = false;
  for (const msg of body.messages) {
    let next = msg;
    if (Array.isArray(msg?.content) && msg.content.some(isToolChangeBlock)) {
      const content = [];
      for (const block of msg.content) {
        if (!isToolChangeBlock(block) || keep(block)) content.push(block);
        else if (block.type === CLAUDE_BLOCK.TOOL_ADDITION) applyAddition(tools, block.tool);
      }
      if (content.length !== msg.content.length) {
        changed = true;
        next = content.length ? { ...msg, content } : null;
      }
    }
    if (!next) {
      dropped = true;
      continue;
    }
    const prev = messages[messages.length - 1];
    if (dropped && prev?.role === next.role) {
      messages[messages.length - 1] = { ...prev, content: [...asBlocks(prev.content), ...asBlocks(next.content)] };
    } else {
      messages.push(next);
    }
    dropped = false;
  }
  if (!changed) return body;
  if (dropped && messages[messages.length - 1]?.role === ROLE.ASSISTANT) {
    messages.push({ role: ROLE.USER, content: [{ type: CLAUDE_BLOCK.TEXT, text: CLAUDE_PREFILL_CONTINUATION_TEXT }] });
  }
  const out = { ...body, messages };
  if (tools.length || Array.isArray(body.tools)) out.tools = tools;
  return out;
}
