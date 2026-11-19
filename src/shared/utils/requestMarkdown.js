import { Lexer, Marked, Tokenizer } from "marked";

// The preview renders on the dashboard's main thread, and marked has inputs
// that make it slow or overflow the stack.
export const MARKDOWN_LIMITS = {
  // Longer messages are shown as plain text.
  chars: 50_000,
  // For each * _ or ~ that might open emphasis, marked scans the rest of the
  // paragraph for a closer: "a*_" repeated took ~1 s at 4 KB and ~33 s at
  // 24 KB. Past this many scanned characters per message, the remaining
  // delimiters are left as literal text.
  emphasisScan: 2_000_000,
  // Deeper lines are shown as plain text: 256 levels of indented lists took
  // ~1 s, and 20,000 "- " or "> " took seconds and then overflowed the stack.
  nesting: 64,
};

const CONTAINER_PREFIX = /^(?:[ \t]*(?:>|[-+*](?=[ \t]|$)|\d{1,9}[.)](?=[ \t]|$)))+/;
const CONTAINER_MARKER = />|[-+*]|\d{1,9}[.)]/g;

function tooLargeToRender(source) {
  if (source.length > MARKDOWN_LIMITS.chars) return true;
  return source.split("\n").some((line) => {
    const indent = line.length - line.trimStart().length;
    const markers = line.match(CONTAINER_PREFIX)?.[0].match(CONTAINER_MARKER)?.length || 0;
    return markers + Math.floor(indent / 2) > MARKDOWN_LIMITS.nesting;
  });
}

let emphasisScanLeft = 0;

// A delimiter that finds its closer scanned up to it; one that doesn't scanned
// the rest of the paragraph. Once the budget is spent, returning nothing
// leaves the remaining delimiters as plain text.
function budgeted(name, delimiters) {
  const original = Tokenizer.prototype[name];
  return function (src, ...rest) {
    if (!delimiters.includes(src[0])) return original.call(this, src, ...rest);
    if (emphasisScanLeft <= 0) return undefined;
    const token = original.call(this, src, ...rest);
    emphasisScanLeft -= token ? token.raw.length : src.length;
    return token;
  };
}

// marked's text and bare-URL rules look ahead for an e-mail address at every
// token, through the whole run of characters an address may contain: 48 KB of
// "a!" took ~3.5 s, of "_a" ~3.3 s. An address's local part is at most 64
// characters.
const URL_START = /^(?:mailto:|xmpp:|https?:\/\/|ftp:\/\/|www\.|[A-Za-z0-9._+-]{1,64}@)/i;
const EMAIL_LOCAL_PART = "[a-zA-Z0-9.!#$%&'*+\\/=?_`{\\|}~-]+@";
const markedText = Lexer.rules.inline.breaks.text;
export const BOUNDED_TEXT_RULE = new RegExp(
  markedText.source.replaceAll(EMAIL_LOCAL_PART, "[a-zA-Z0-9.!#$%&'*+\\/=?_`{\\|}~-]{1,64}@"),
  markedText.flags,
);

function inlineText(src) {
  const match = BOUNDED_TEXT_RULE.exec(src);
  // The renderer escapes all text, so the token keeps the source as written.
  if (match) return { type: "text", raw: match[0], text: match[0], escaped: false };
}

const HTML_ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

// Keeps entities the author wrote (&amp;, &#39;) as they are, like marked does.
function escapeText(text) {
  return String(text ?? "").replace(/&(?!#?\w+;)|[<>"']/g, (ch) => HTML_ESCAPES[ch]);
}

function escapeAll(text) {
  return String(text ?? "").replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]);
}

// Prompts and replies are untrusted. Its own instance, so a global
// marked.use() elsewhere in the app can't change what this renders.
const promptMarked = new Marked({
  gfm: true,
  breaks: true,
  tokenizer: {
    emStrong: budgeted("emStrong", "*_"),
    del: budgeted("del", "~"),
    inlineText,
    url: (src) => (URL_START.test(src) ? false : undefined),
  },
  renderer: {
    html: () => "",
    // marked passes text after an inline <code>, <pre>, <kbd> or <script>
    // tag through unescaped, even though html() drops the tag itself.
    text(token) {
      return token.tokens ? this.parser.parseInline(token.tokens) : escapeText(token.text);
    },
    link(token) {
      if (!/^(https?:\/\/|mailto:)/i.test(token.href || "")) {
        return this.parser.parseInline(token.tokens || []);
      }
      return false;
    },
    image: () => "<span>[image omitted]</span>",
  },
});

function plainText(markdown, note) {
  return `<p><em>${note}</em></p><pre class="whitespace-pre-wrap break-words">${escapeAll(markdown)}</pre>`;
}

function contentToMarkdown(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) {
    return content == null ? "" : `\`\`\`json\n${JSON.stringify(content, null, 2)}\n\`\`\``;
  }

  return content.map((block) => {
    if (typeof block === "string") return block;
    if (!block || typeof block !== "object") return String(block ?? "");
    if (typeof block.text === "string") return block.text;
    if (typeof block.content === "string") return block.content;
    if (block.type === "image_url" || block.type === "image") return "[image omitted]";
    return `\`\`\`json\n${JSON.stringify(block, null, 2)}\n\`\`\``;
  }).filter(Boolean).join("\n\n");
}

export function promptToMarkdown(request) {
  const messages = Array.isArray(request?.messages) ? request.messages : [];
  if (messages.length > 0) {
    return messages.map((message) => {
      const role = String(message?.role || "message");
      const label = role.charAt(0).toUpperCase() + role.slice(1);
      const content = contentToMarkdown(message?.content);
      return `## ${label}\n\n${content || "_[No text content]_"}`;
    }).join("\n\n");
  }

  const sections = [];
  if (typeof request?.instructions === "string" && request.instructions.trim()) {
    sections.push(`## Instructions\n\n${request.instructions}`);
  }
  const input = request?.input ?? request?.prompt ?? request?.contents;
  const inputMarkdown = contentToMarkdown(input);
  if (inputMarkdown) sections.push(inputMarkdown);
  return sections.join("\n\n");
}

export function renderPromptMarkdown(markdown) {
  const source = String(markdown || "_[No readable prompt content]_");
  if (tooLargeToRender(source)) {
    return plainText(source, "Too long or too deeply nested to show as Markdown, so it's shown as plain text.");
  }
  emphasisScanLeft = MARKDOWN_LIMITS.emphasisScan;
  try {
    return promptMarked.parse(source);
  } catch {
    return plainText(source, "Couldn't render this as Markdown, so it's shown as plain text.");
  }
}
