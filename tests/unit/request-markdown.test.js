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

  it("renders markdown while dropping raw HTML and unsafe links", () => {
    const html = renderPromptMarkdown(
      "# Prompt\n\n<script>alert(1)</script>\n\n[x](javascript:alert(1))"
    );

    expect(html).toContain("<h1>Prompt</h1>");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("javascript:");
  });
});
