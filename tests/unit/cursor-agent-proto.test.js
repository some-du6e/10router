import { describe, expect, it } from "vitest";
import {
  buildChatRequest,
  buildToolResultRequest,
  decodeMessage,
  decodeVarint,
  encodeField,
  encodeMessage,
  encodeMcpTool,
  encodeToolResult,
  encodeVarint,
  extractTextFromResponse,
  generateCursorBody,
  generateToolResultBody,
  parseConnectRPCFrame,
  wrapConnectRPCFrame,
} from "../../open-sse/utils/cursorProtobuf.js";

const LEN = 2;
const VARINT = 0;

const text = (message, field) => {
  const value = message.get(field)?.[0]?.value;
  return value == null ? undefined : Buffer.from(value).toString("utf8");
};

describe("Cursor protobuf codec", () => {
  it("round-trips the varint values used by the protocol", () => {
    for (const value of [0, 1, 127, 128, 300, 16384, 0x0fffffff]) {
      const encoded = encodeVarint(value);
      expect(decodeVarint(encoded, 0)).toEqual([value, encoded.length]);
    }
  });

  it("decodes repeated length-delimited and varint fields", () => {
    const payload = Buffer.concat([
      Buffer.from(encodeField(1, LEN, "hello")),
      Buffer.from(encodeField(1, LEN, "world")),
      Buffer.from(encodeField(2, VARINT, 1)),
    ]);
    const message = decodeMessage(payload);

    expect(message.get(1).map(({ value }) => Buffer.from(value).toString("utf8"))).toEqual(["hello", "world"]);
    expect(message.get(2)[0].value).toBe(1);
  });

  it("encodes an OpenAI tool definition using the current Cursor schema", () => {
    const schema = { type: "object", properties: { city: { type: "string" } } };
    const message = decodeMessage(encodeMcpTool({
      function: { name: "get_weather", description: "Get weather", parameters: schema },
    }));

    expect(text(message, 1)).toBe("get_weather");
    expect(text(message, 2)).toBe("Get weather");
    expect(JSON.parse(text(message, 3))).toEqual(schema);
    expect(text(message, 4)).toBe("custom");
  });

  it("encodes chat messages, agent mode, and MCP tools in a request", () => {
    const tool = { function: { name: "get_weather", parameters: { type: "object" } } };
    const request = decodeMessage(decodeMessage(buildChatRequest(
      [{ role: "user", content: "weather?" }],
      "gpt-5.2",
      [tool],
    )).get(1)[0].value);
    const message = decodeMessage(request.get(1)[0].value);
    const model = decodeMessage(request.get(5)[0].value);

    expect(text(message, 1)).toBe("weather?");
    expect(message.get(2)[0].value).toBe(1);
    expect(message.get(29)[0].value).toBe(1);
    expect(message.get(47)[0].value).toBe(2);
    expect(text(model, 1)).toBe("gpt-5.2");
    expect(request.get(27)[0].value).toBe(1);
    expect(JSON.parse(text(decodeMessage(request.get(34)[0].value), 3))).toEqual({ type: "object" });
  });

  it("normalizes a tool result into Cursor's nested client-side result", () => {
    const toolResult = decodeMessage(encodeToolResult({
      tool_call_id: "call_123\nmc_model_456",
      tool_name: "mcp_custom_search",
      raw_args: '{"query":"cursor"}',
      result_content: "found it",
    }));

    expect(text(toolResult, 1)).toBe("call_123");
    expect(text(toolResult, 2)).toBe("mcp_custom_search");
    expect(text(toolResult, 5)).toBe('{"query":"cursor"}');

    const result = decodeMessage(toolResult.get(8)[0].value);
    expect(result.get(1)[0].value).toBe(19);
    expect(text(decodeMessage(result.get(28)[0].value), 1)).toBe("search");
    expect(text(decodeMessage(result.get(28)[0].value), 2)).toBe("found it");
    expect(text(result, 35)).toBe("call_123");
    expect(text(result, 48)).toBe("model_456");
  });

  it("builds a framed tool-result request", () => {
    const frame = parseConnectRPCFrame(generateToolResultBody({
      tool_call_id: "call_123",
      tool_name: "search",
      result_content: "done",
    }));
    const request = decodeMessage(frame.payload);

    expect(frame.flags).toBe(0);
    expect(request.has(2)).toBe(true);
    expect(decodeMessage(request.get(2)[0].value).get(1)[0].value).toBe(19);
  });

  it("frames and parses uncompressed and gzip payloads", () => {
    const payload = encodeField(1, LEN, "hello");

    for (const compressed of [false, true]) {
      const frame = wrapConnectRPCFrame(payload, compressed);
      const parsed = parseConnectRPCFrame(frame);
      expect(parsed.flags).toBe(compressed ? 1 : 0);
      expect(parsed.length).toBe(frame.length - 5);
      expect(Buffer.from(parsed.payload)).toEqual(Buffer.from(payload));
      expect(parsed.consumed).toBe(frame.length);
    }

    expect(parseConnectRPCFrame(new Uint8Array([0, 0, 0]))).toBeNull();
  });

  it("generates a framed chat body that can be parsed back", () => {
    const frame = parseConnectRPCFrame(generateCursorBody(
      [{ role: "user", content: "hello" }],
      "gpt-5.2",
    ));
    const envelope = decodeMessage(frame.payload);

    expect(frame.flags).toBe(0);
    expect(envelope.has(1)).toBe(true);
    expect(decodeMessage(envelope.get(1)[0].value).get(5)).toBeDefined();
  });

  it("extracts text and thinking from a Cursor response", () => {
    const thinking = encodeField(1, LEN, "private reasoning");
    const response = Buffer.concat([
      Buffer.from(encodeField(1, LEN, "answer")),
      Buffer.from(encodeField(25, LEN, thinking)),
    ]);

    expect(extractTextFromResponse(encodeField(2, LEN, response))).toEqual({
      text: "answer",
      error: null,
      toolCall: null,
      thinking: "private reasoning",
    });
  });

  it("extracts a Cursor MCP tool call from a response", () => {
    const toolCall = Buffer.concat([
      Buffer.from(encodeField(3, LEN, "call_123\nmetadata")),
      Buffer.from(encodeField(9, LEN, "search")),
      Buffer.from(encodeField(10, LEN, '{"query":"cursor"}')),
      Buffer.from(encodeField(11, VARINT, 1)),
    ]);
    const result = extractTextFromResponse(encodeField(1, LEN, toolCall));

    expect(result).toEqual({
      text: null,
      error: null,
      thinking: null,
      toolCall: {
        id: "call_123",
        type: "function",
        function: { name: "search", arguments: '{"query":"cursor"}' },
        isLast: true,
      },
    });
  });

  it("encodes tool results on messages when the legacy request path needs them", () => {
    const message = decodeMessage(encodeMessage(
      "",
      2,
      "assistant-1",
      null,
      true,
      true,
      [{
        tool_call_id: "call_123",
        tool_name: "search",
        result_content: "done",
      }],
    ));

    expect(text(message, 1)).toBe("");
    expect(message.get(2)[0].value).toBe(2);
    expect(text(message, 13)).toBe("assistant-1");
    expect(message.get(18)).toHaveLength(1);
    expect(message.get(29)[0].value).toBe(1);
    expect(message.get(47)[0].value).toBe(2);
    expect(message.get(51)).toHaveLength(1);
  });
});
