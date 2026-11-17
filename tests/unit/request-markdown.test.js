import { afterEach, describe, it, expect, vi } from "vitest";
import { Lexer, marked } from "marked";
import {
  BOUNDED_TEXT_RULE,
  MARKDOWN_LIMITS,
  promptToMarkdown,
  renderPromptMarkdown,
} from "@/shared/utils/requestMarkdown.js";
import { getConversation } from "@/shared/utils/requestConversation.js";

// ConversationInspector puts renderPromptMarkdown's output straight into
// dangerouslySetInnerHTML with no sanitizer, so every tag and attribute this
// returns ends up live in the dashboard.
const SAFE_TAGS = new Set([
  "a", "blockquote", "br", "code", "del", "em", "h1", "h2", "h3", "h4", "h5",
  "h6", "hr", "input", "li", "ol", "p", "pre", "span", "strong", "table",
  "tbody", "td", "th", "thead", "tr", "ul",
]);
const SAFE_ATTRIBUTES = new Set(["href", "title", "class", "start", "align", "type", "checked", "disabled"]);

function expectInert(html) {
  // Also catches a tag the browser would still open without its closing ">".
  for (const [opening, rawName] of html.matchAll(/<\/?([a-zA-Z][\w-]*)/g)) {
    expect(SAFE_TAGS.has(rawName.toLowerCase()), `unexpected tag ${opening}`).toBe(true);
  }
  for (const [tag, rawName, rawAttrs] of html.matchAll(/<\/?([a-zA-Z][\w-]*)([^>]*)>/g)) {
    const name = rawName.toLowerCase();
    expect(SAFE_TAGS.has(name), `unexpected tag ${tag}`).toBe(true);
    for (const [, attr, , value = ""] of rawAttrs.matchAll(/([^\s=/]+)(="([^"]*)")?/g)) {
      expect(SAFE_ATTRIBUTES.has(attr.toLowerCase()), `unexpected attribute in ${tag}`).toBe(true);
      if (attr.toLowerCase() === "href") {
        expect(value, `unsafe href in ${tag}`).toMatch(/^(https?:\/\/|mailto:)/i);
      }
    }
  }
  expect(html).not.toMatch(/<(script|img|svg|iframe|object|embed|style|math)\b/i);
}

const HOSTILE = [
  "[x](javascript:alert(1))",
  "[<img src=x onerror=alert(1)>](javascript:alert(1))",
  "[<img src=x onerror=alert(1)>](data:text/html,<script>alert(1)</script>)",
  "[<svg onload=alert(1)>](vbscript:msgbox(1))",
  "[x](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)",
  "[<img src=x onerror=alert(1)>](//example.com)",
  "[<img src=x onerror=alert(1)>](#top)",
  "[<img src=x onerror=alert(1)>]( JAVASCRIPT:alert(1))",
  "[x](java&#x73;cript:alert(1))",
  "[<img src=x onerror=alert(1)>][ref]\n\n[ref]: javascript:alert(1)",
  "[<img src=x onerror=alert(1)>]\n\n[<img src=x onerror=alert(1)>]: javascript:alert(1)",
  "[[<img src=x onerror=alert(1)>](javascript:alert(1))](https://example.com)",
  "[a [<img src=x onerror=alert(1)>] b](javascript:alert(1))",
  "<javascript:alert(1)>",
  "<img src=x onerror=alert(1)>",
  "hello <img src=x onerror=alert(1)> there",
  "<svg><script>alert(1)</script></svg>",
  "<a href=\"javascript:alert(1)\">x</a>",
  "<iframe src=\"javascript:alert(1)\"></iframe>",
  "![x](javascript:alert(1))",
  "![<img src=x onerror=alert(1)>](https://example.com/a.png)",
  "[x](https://example.com \"\\\" onmouseover=alert(1) x=\\\"\")",
  "[x](https://example.com/\"onmouseover=\"alert(1))",
  "[x](<https://example.com/\" onmouseover=\"alert(1)>)",
  "| a | b |\n| - | - |\n| <img src=x onerror=alert(1)> | [<svg onload=alert(1)>](javascript:1) |",
  "> [<img src=x onerror=alert(1)>](javascript:alert(1))",
  "- [ ] [<img src=x onerror=alert(1)>](javascript:alert(1))",
  "**[<img src=x onerror=alert(1)>](javascript:alert(1))**",
  // An inline <code>, <pre>, <kbd> or <script> puts marked in raw mode, and it
  // used to pass the text after it through unescaped.
  "a <code> <img src=x onerror=alert(1)",
  "a <code> <img src=x onerror=alert(1)>",
  "a <code>\n\nnext paragraph <img src=x onerror=alert(1)",
  "<script> <img src=x onerror=alert(1)",
  "<kbd> <img src=x onerror=alert(1)",
  "<pre> <svg onload=alert(1)",
  "<CODE> <img src=x onerror=alert(1)",
  "<code class=x> <img src=x onerror=alert(1)",
  "<script type=x> <iframe src=javascript:alert(1)",
  "a <code> &lt;b&gt; <img src=x onerror=alert(1)",
  "a <code></code> <img src=x onerror=alert(1)",
  "| a |\n| - |\n| <code> <img src=x onerror=alert(1) |",
  "> <code> <img src=x onerror=alert(1)",
  "- <code> <img src=x onerror=alert(1)",
  "# <code> <img src=x onerror=alert(1)",
  "**<code> <img src=x onerror=alert(1)**",
  "[<code> <img src=x onerror=alert(1)](javascript:0)",
  "[<script> <img src=x onerror=alert(1)](https://example.com)",
  "`x` <code> <img src=x onerror=alert(1)",
  "&lt;img src=x onerror=alert(1)&gt;",
];

describe("request markdown preview", () => {
  it("turns a message conversation into role headings and markdown", () => {
    const markdown = promptToMarkdown({
      messages: [
        { role: "system", content: "You are concise." },
        { role: "user", content: "**Hello**\n\n- Keep it short" },
      ],
    });

    expect(markdown).toContain("## System");
    expect(markdown).toContain("## User");
    expect(markdown).toContain("**Hello**");
  });

  it("renders Responses API input and instructions", () => {
    const markdown = promptToMarkdown({
      instructions: "Use short sentences.",
      input: [{
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Summarize this" }],
      }],
    });

    expect(markdown).toContain("Use short sentences.");
    expect(markdown).toContain("Summarize this");
  });

  it("renders markdown while dropping raw HTML and unsafe links", () => {
    const html = renderPromptMarkdown(
      "# Prompt\n\n<script>alert(1)</script>\n\n[x](javascript:alert(1))"
    );

    expect(html).toContain("<h1>Prompt</h1>");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("javascript:");
  });

  it.each(HOSTILE)("renders hostile markdown %j as inert HTML", (markdown) => {
    expectInert(renderPromptMarkdown(markdown));
  });

  it("renders allowed links through the same HTML-filtering parser", () => {
    const html = renderPromptMarkdown("[**Docs** <img src=x onerror=alert(1)>](https://example.com)");
    expect(html).toContain('<a href="https://example.com">');
    expect(html).toContain("<strong>Docs</strong>");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("onerror");
  });

  it.each(["javascript:alert(1)", "data:text/html,unsafe", "//example.com"])(
    "filters HTML inside the label of a rejected %s link",
    (href) => {
      const html = renderPromptMarkdown(`[**Text** <img src=x onerror=alert(1)>](${href})`);
      expect(html).toContain("<strong>Text</strong>");
      expect(html).not.toContain("<a ");
      expect(html).not.toContain("<img");
      expect(html).not.toContain("onerror");
    }
  );

  it("keeps a rejected link's label text, escaped", () => {
    const html = renderPromptMarkdown("[1 < 2 & 3](javascript:alert(1)) and <javascript:alert(1)>");
    expect(html).toContain("1 &lt; 2 &amp; 3");
    expect(html).toContain("javascript:alert(1)");
    expect(html).not.toContain("<a ");
  });

  it("still renders normal links, autolinks and code", () => {
    const html = renderPromptMarkdown(
      [
        "See [the docs](https://example.com/docs?a=1&b=2 \"Docs\") and <https://example.com/auto>.",
        "Mail <someone@example.com> or visit www.example.com.",
        "Inline `<img src=x onerror=alert(1)>` code.",
        "```html\n<script>alert(1)</script>\n```",
      ].join("\n\n"),
    );
    expect(html).toContain('<a href="https://example.com/docs?a=1&amp;b=2" title="Docs">the docs</a>');
    expect(html).toContain('<a href="https://example.com/auto">https://example.com/auto</a>');
    expect(html).toContain('<a href="mailto:someone@example.com">someone@example.com</a>');
    expect(html).toContain('<a href="http://www.example.com">www.example.com</a>');
    expect(html).toContain("<code>&lt;img src=x onerror=alert(1)&gt;</code>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expectInert(html);
  });

  it("keeps hostile request and upstream response text inert in the inspector", () => {
    const payload = "[<img src=x onerror=alert(1)>](javascript:alert(1))";
    const { messages } = getConversation(
      { messages: [{ role: "user", content: payload }] },
      { content: payload },
    );
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    for (const message of messages) {
      expect(message.text).toContain("onerror");
      expectInert(renderPromptMarkdown(message.text));
    }
  });

  it("ignores a global marked.use() elsewhere in the app", () => {
    marked.use({ renderer: { html: ({ text }) => text } });
    expect(marked.parse("<img src=x onerror=alert(1)>")).toContain("<img");
    expectInert(renderPromptMarkdown("<img src=x onerror=alert(1)> [x](javascript:0)"));
  });
});

// The preview renders on the dashboard's main thread: a message must not
// freeze the tab or throw out of ConversationInspector's render.
describe("request markdown preview on hostile sizes", () => {
  const PLAIN_TEXT_NOTE = "shown as plain text";
  const PAYLOAD = "<img src=x onerror=alert(1)> &amp; *x*";

  function expectPlainText(html) {
    expect(html).toContain(PLAIN_TEXT_NOTE);
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt; &amp;amp; *x*");
    expectInert(html);
  }

  function timed(markdown) {
    const start = performance.now();
    const html = renderPromptMarkdown(markdown);
    return { html, ms: performance.now() - start };
  }

  afterEach(() => vi.restoreAllMocks());

  it("shows a message past the length cap as escaped plain text", () => {
    const markdown = PAYLOAD + " ".repeat(MARKDOWN_LIMITS.chars);
    expectPlainText(renderPromptMarkdown(markdown));
    expect(renderPromptMarkdown(markdown.slice(0, MARKDOWN_LIMITS.chars))).not.toContain(PLAIN_TEXT_NOTE);
  });

  it.each([
    ["blockquotes", "> "],
    ["lists", "- "],
    ["ordered lists", "1. "],
    ["mixed containers", "> - "],
  ])("shows %s nested past the limit as plain text instead of overflowing the stack", (_, marker) => {
    const depth = MARKDOWN_LIMITS.nesting + 1;
    expectPlainText(renderPromptMarkdown(`${marker.repeat(depth)}${PAYLOAD}`));
    // The reviewer's input: 3,000 levels used to throw "Maximum call stack size exceeded".
    expectPlainText(renderPromptMarkdown(`${marker.repeat(3000)}${PAYLOAD}`));
  });

  it("shows lists indented past the nesting limit as plain text", () => {
    const lines = Array.from({ length: MARKDOWN_LIMITS.nesting + 2 }, (_, i) => `${" ".repeat(i * 2)}- item`);
    expectPlainText(renderPromptMarkdown(`${lines.join("\n")}\n\n${PAYLOAD}`));
  });

  it("still renders nesting up to the limit as Markdown", () => {
    const html = renderPromptMarkdown(`${"> ".repeat(MARKDOWN_LIMITS.nesting)}**deep**`);
    expect(html).not.toContain(PLAIN_TEXT_NOTE);
    expect(html).toContain("<strong>deep</strong>");
  });

  it("falls back to escaped plain text when marked throws", () => {
    vi.spyOn(Lexer.prototype, "lex").mockImplementation(() => {
      throw new RangeError("Maximum call stack size exceeded");
    });
    expectPlainText(renderPromptMarkdown(PAYLOAD));
  });

  it("bounds marked's e-mail lookahead to an address's 64-character local part", () => {
    expect(BOUNDED_TEXT_RULE.source).not.toBe(Lexer.rules.inline.breaks.text.source);
    expect(BOUNDED_TEXT_RULE.source).not.toContain("~-]+@");
  });

  // Each took 3 s to minutes before; the limits are ~10x what they take now.
  it.each([
    ["a*_", 2500],
    ["_*a", 2500],
    ["a~_", 2500],
    ["a!", 1500],
    ["_a", 1500],
  ])("renders %j repeated up to the length cap quickly", (pattern, limitMs) => {
    const markdown = pattern.repeat(Math.floor(MARKDOWN_LIMITS.chars / pattern.length));
    const { html, ms } = timed(markdown);
    expect(html).not.toContain(PLAIN_TEXT_NOTE);
    expect(ms).toBeLessThan(limitMs);
  });

  it("keeps emphasis in a long paragraph full of ordinary bold and italics", () => {
    const spans = 300;
    const markdown = Array.from(
      { length: spans },
      (_, i) => `words words words words words words words words words words **bold ${i}** and _em ${i}_ and ~~del ${i}~~`,
    ).join(" ");
    const { html } = timed(markdown);
    expect(html.match(/<strong>/g)).toHaveLength(spans);
    expect(html.match(/<em>/g)).toHaveLength(spans);
    expect(html.match(/<del>/g)).toHaveLength(spans);
  });

  it("still links bare URLs and e-mail addresses", () => {
    const html = renderPromptMarkdown("Mail someone@example.com, see https://example.com/x or www.example.com.");
    expect(html).toContain('<a href="mailto:someone@example.com">someone@example.com</a>');
    expect(html).toContain('<a href="https://example.com/x">https://example.com/x</a>');
    expect(html).toContain('<a href="http://www.example.com">www.example.com</a>');
  });
});
