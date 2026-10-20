import { CLAUDE_BLOCK } from "open-sse/translator/schema/index.js";

// Claude Code's WebSearch tool runs each search as a side request: one user
// message with this prefix, and the built-in web_search tool as the only tool.
// On a non-Claude upstream that request used to go to the model just so it
// could summarize results the gateway had already fetched. Answering it here
// skips that model call, which was most of the tool's latency.
const SIDE_QUERY_PREFIX = "Perform a web search for the query:";

type SearchResult = { title?: string; url?: string; link?: string; snippet?: string; content?: string; text?: string };
type SearchData = { results?: SearchResult[] };

type Block = { type?: string; text?: string };
type Message = { role?: string; content?: string | Block[] };
type Tool = { type?: string; name?: string };
type ClaudeBody = {
  model?: string;
  stream?: boolean;
  messages?: Message[];
  tools?: Tool[];
};

function messageText(content: Message["content"]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block?.type === CLAUDE_BLOCK.TEXT && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

/**
 * The query of a search-only side request, or null when the body is an
 * ordinary chat turn that should still reach the model.
 */
export function getSideSearchQuery(body: ClaudeBody | null | undefined): string | null {
  const tools = Array.isArray(body?.tools) ? body.tools : [];
  if (!tools.length || !tools.every((tool) => tool?.type === CLAUDE_BLOCK.WEB_SEARCH_TOOL)) return null;

  const messages = Array.isArray(body?.messages) ? body.messages : [];
  if (messages.length !== 1 || messages[0]?.role !== "user") return null;

  // Only Claude Code's own phrasing: any other search-only request may expect
  // the model to do more with the results than list them.
  const text = messageText(messages[0].content).trim();
  if (!text.startsWith(SIDE_QUERY_PREFIX)) return null;
  return text.slice(SIDE_QUERY_PREFIX.length).trim() || null;
}

function resultsText(query: string, results: SearchResult[]): string {
  if (!results.length) return `No web results found for "${query}".`;
  return results.map((result, index) => {
    const url = result.url || result.link || "";
    const excerpt = (result.snippet || result.content || result.text || "").trim();
    return [`[${index + 1}] ${result.title || url}`, url, excerpt].filter(Boolean).join("\n");
  }).join("\n\n");
}

function toolResultContent(results: SearchResult[]) {
  return results
    .filter((result) => result.url || result.link)
    .map((result) => ({
      type: "web_search_result",
      title: result.title || result.url || result.link,
      url: result.url || result.link,
      encrypted_content: "",
      page_age: null,
    }));
}

/**
 * Build the Claude assistant message a real web_search turn would produce:
 * server_tool_use, then web_search_tool_result, then text with the snippets
 * (Claude Code passes that text on to the main model alongside the links).
 */
export function buildSideSearchMessage(model: string, query: string, data: SearchData | null | undefined) {
  const id = `msg_${crypto.randomUUID().replace(/-/g, "")}`;
  const toolUseId = `srvtoolu_${crypto.randomUUID().replace(/-/g, "")}`;
  const results = Array.isArray(data?.results) ? data.results.filter(Boolean) : [];
  const text = resultsText(query, results);
  return {
    id,
    type: "message",
    role: "assistant",
    model,
    content: [
      { type: CLAUDE_BLOCK.SERVER_TOOL_USE, id: toolUseId, name: "web_search", input: { query } },
      { type: CLAUDE_BLOCK.WEB_SEARCH_TOOL_RESULT, tool_use_id: toolUseId, content: toolResultContent(results) },
      { type: CLAUDE_BLOCK.TEXT, text },
    ],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      server_tool_use: { web_search_requests: 1 },
    },
  };
}

type SideSearchMessage = ReturnType<typeof buildSideSearchMessage>;

function sse(event: Record<string, unknown> & { type: string }): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

function streamEvents(message: SideSearchMessage): string {
  const [toolUse, toolResult, textBlock] = message.content;
  const events = [
    sse({ type: "message_start", message: { ...message, content: [], stop_reason: null, usage: { input_tokens: 0, output_tokens: 0 } } }),
    sse({ type: "content_block_start", index: 0, content_block: { ...toolUse, input: {} } }),
    sse({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(toolUse.input) } }),
    sse({ type: "content_block_stop", index: 0 }),
    sse({ type: "content_block_start", index: 1, content_block: toolResult }),
    sse({ type: "content_block_stop", index: 1 }),
    sse({ type: "content_block_start", index: 2, content_block: { type: CLAUDE_BLOCK.TEXT, text: "" } }),
    sse({ type: "content_block_delta", index: 2, delta: { type: "text_delta", text: textBlock.text } }),
    sse({ type: "content_block_stop", index: 2 }),
    sse({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: message.usage }),
    sse({ type: "message_stop" }),
  ];
  return events.join("");
}

export function sideSearchResponse(message: SideSearchMessage, stream: boolean): Response {
  if (!stream) {
    return new Response(JSON.stringify(message), {
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  }
  return new Response(streamEvents(message), {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
