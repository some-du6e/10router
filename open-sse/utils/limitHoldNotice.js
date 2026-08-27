// The banner we write during a rate-limit hold lands inside the assistant turn,
// so the client sends it back as history on the next request. Left unexplained
// the model reads its own past output as having announced a limit — and tends to
// apologise for, or role-play around, text it never wrote.
//
// So: detect the sentinel in inbound history and prepend a real system turn
// telling the model what those lines actually are. Stateless — nothing to track
// between requests, and it keeps working across restarts.
import { FORMATS } from "../translator/formats.js";
import { LIMIT_HOLD_SENTINEL } from "./limitHold.js";

const NOTICE =
  `Some assistant messages in this conversation contain a status line marked ` +
  `"${LIMIT_HOLD_SENTINEL}". Those lines were inserted by the 10router gateway to report ` +
  `an upstream rate limit while the request waited — they are not your output and not ` +
  `part of the conversation. Ignore them completely: do not comment on them, apologise ` +
  `for them, or reproduce them in your reply.`;

/** Flatten any of the content shapes a message can carry into searchable text. */
function textOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object") return part.text || part.content || "";
        return "";
      })
      .join(" ");
  }
  if (content && typeof content === "object") return content.text || "";
  return "";
}

/** Does this request carry a banner we previously emitted? */
export function hasLimitHoldBanner(body) {
  if (!body || typeof body !== "object") return false;
  const buckets = [body.messages, body.contents, body.input].filter(Array.isArray);
  for (const bucket of buckets) {
    for (const msg of bucket) {
      if (!msg || typeof msg !== "object") continue;
      // Only assistant/model turns can hold a banner; skip user text that merely
      // quotes one so a pasted transcript doesn't trigger the notice.
      const role = msg.role || (msg.parts ? "model" : null);
      if (role && role !== "assistant" && role !== "model") continue;
      const text = textOf(msg.content ?? msg.parts ?? msg.text);
      if (text.includes(LIMIT_HOLD_SENTINEL)) return true;
    }
  }
  return false;
}

/**
 * Prepend the notice as a genuine system turn, in whichever shape the source
 * format uses for system instructions. Returns a new body; never mutates.
 */
export function injectLimitHoldNotice(body, sourceFormat) {
  if (!hasLimitHoldBanner(body)) return body;

  // Claude keeps system prompts in a top-level field, not in messages.
  if (sourceFormat === FORMATS.CLAUDE) {
    const existing = body.system;
    if (Array.isArray(existing)) {
      return { ...body, system: [...existing, { type: "text", text: NOTICE }] };
    }
    if (typeof existing === "string" && existing) {
      return { ...body, system: `${existing}\n\n${NOTICE}` };
    }
    return { ...body, system: NOTICE };
  }

  // Gemini: systemInstruction is a Content object with parts.
  if (sourceFormat === FORMATS.GEMINI || sourceFormat === FORMATS.GEMINI_CLI || sourceFormat === FORMATS.ANTIGRAVITY) {
    const existing = body.systemInstruction || body.system_instruction;
    const parts = Array.isArray(existing?.parts) ? [...existing.parts, { text: NOTICE }] : [{ text: NOTICE }];
    return { ...body, systemInstruction: { role: "system", parts } };
  }

  // Responses API: free-text instructions field alongside input[].
  if (sourceFormat === FORMATS.OPENAI_RESPONSES) {
    const existing = typeof body.instructions === "string" ? body.instructions : "";
    return { ...body, instructions: existing ? `${existing}\n\n${NOTICE}` : NOTICE };
  }

  // OpenAI-shaped: a system message at the head of the array. Placed after any
  // leading system messages so it can't displace the caller's own prompt.
  if (!Array.isArray(body.messages)) return body;
  const messages = [...body.messages];
  let insertAt = 0;
  while (insertAt < messages.length && messages[insertAt]?.role === "system") insertAt += 1;
  messages.splice(insertAt, 0, { role: "system", content: NOTICE });
  return { ...body, messages };
}
