import { marked } from "marked";

const markdownRenderer = new marked.Renderer();
const defaultMarkdownRenderer = new marked.Renderer();

// Prompts are user-controlled content. Keep the preview markdown-only and
// allow links only when they point to a normal web or mail URL.
markdownRenderer.html = () => "";
markdownRenderer.link = (token) => {
  if (!/^(https?:\/\/|mailto:)/i.test(token.href || "")) {
    return token.text || "";
  }
  return defaultMarkdownRenderer.link(token);
};
markdownRenderer.image = () => "<span>[image omitted]</span>";

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

  const input = request?.input ?? request?.prompt ?? request?.contents;
  return contentToMarkdown(input);
}

export function renderPromptMarkdown(markdown) {
  return marked.parse(markdown || "_[No readable prompt content]_", {
    gfm: true,
    breaks: true,
    renderer: markdownRenderer,
  });
}
