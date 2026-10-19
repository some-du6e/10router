import { describe, it, expect } from "vitest";
import {
  promptToMarkdown,
  renderPromptMarkdown,
} from "@/shared/utils/requestMarkdown.js";

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
});
