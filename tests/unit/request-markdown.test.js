import { describe, it, expect } from "vitest";
import {
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
});
