import { describe, it, expect } from "vitest";

import { CursorExecutor } from "../../open-sse/executors/cursor.js";
import {
  decodeMessage,
  encodeField,
  parseConnectRPCFrame,
  wrapConnectRPCFrame,
} from "../../open-sse/utils/cursorProtobuf.js";

const LEN = 2;

// agent.v1.AgentServerMessage.exec_request (field 2) carrying one ExecServerMessage variant.
function execRequestFrame(execField) {
  const execServerMessage = Buffer.from(encodeField(execField, LEN, new Uint8Array()));
  return Buffer.from(wrapConnectRPCFrame(encodeField(2, LEN, execServerMessage)));
}

// agent.v1.AgentServerMessage.interaction_update (field 1) → text delta.
function textFrame(text) {
  const textPart = Buffer.from(encodeField(1, LEN, text));
  const update = Buffer.from(encodeField(1, LEN, textPart));
  return Buffer.from(wrapConnectRPCFrame(encodeField(1, LEN, update)));
}

function stubAgentSession(executor, frames) {
  const written = [];
  const queue = [...frames];
  executor.openAgentHttp2Stream = () => ({
    responseHeaders: Promise.resolve({ ":status": 200 }),
    write: (frame) => written.push(Buffer.from(frame)),
    end() {},
    close() {},
    async read() {
      if (!queue.length) return { value: undefined, done: true };
      return { value: queue.shift(), done: false };
    },
  });
  return written;
}

const credentials = {
  accessToken: "test-token",
  providerSpecificData: { machineId: "a".repeat(64) },
};

function parseSSE(text) {
  return text
    .split("\n\n")
    .filter((chunk) => chunk.startsWith("data: "))
    .map((chunk) => chunk.slice("data: ".length))
    .filter((data) => data !== "[DONE]")
    .map((data) => JSON.parse(data));
}

async function runAgent({ frames, stream, messages = [{ role: "user", content: "hi" }] }) {
  const executor = new CursorExecutor();
  const written = stubAgentSession(executor, frames);
  const result = await executor.executeAgent({
    model: "gpt-5.2",
    body: { messages },
    stream,
    credentials,
  });
  return { result, written };
}

describe("CursorExecutor AgentService exec_request handling", () => {
  it("acknowledges a request-context exec request without ending the turn", async () => {
    const { result, written } = await runAgent({
      frames: [execRequestFrame(10), textFrame("hello")],
      stream: true,
    });

    expect(written.length).toBe(2); // run frame + request-context reply
    const reply = decodeMessage(parseConnectRPCFrame(written[1]).payload);
    const execClientMessage = decodeMessage(reply.get(2)[0].value);
    expect(execClientMessage.has(10)).toBe(true);
    const events = parseSSE(await result.response.text());
    const content = events.map((e) => e.choices?.[0]?.delta?.content || "").join("");
    expect(content).toBe("hello");
  });

  it("sends the current AgentService run frame through the public executor API", async () => {
    const { written } = await runAgent({
      frames: [],
      stream: false,
      messages: [
        { role: "system", content: "be brief" },
        { role: "user", content: "first" },
        { role: "assistant", content: "earlier answer" },
        { role: "user", content: "current" },
      ],
    });
    const clientMessage = decodeMessage(parseConnectRPCFrame(written[0]).payload);
    const runRequest = decodeMessage(clientMessage.get(1)[0].value);
    const action = decodeMessage(runRequest.get(2)[0].value);
    const userAction = decodeMessage(action.get(1)[0].value);
    const userMessage = decodeMessage(userAction.get(1)[0].value);
    const model = decodeMessage(runRequest.get(9)[0].value);

    expect(runRequest.has(8)).toBe(true);
    expect(Buffer.from(runRequest.get(8)[0].value).toString("utf8")).toBe("be brief");
    expect(Buffer.from(model.get(1)[0].value).toString("utf8")).toBe("gpt-5.2");
    expect(Buffer.from(userMessage.get(1)[0].value).toString("utf8")).toBe("current");
    expect(decodeMessage(userAction.get(7)[0].value).get(1)).toHaveLength(2);
  });

  it("does not render an unsupported exec request as assistant content", async () => {
    const { result } = await runAgent({
      frames: [textFrame("partial answer"), execRequestFrame(2)],
      stream: true,
    });

    const body = await result.response.text();
    expect(body).not.toContain("unsupported IDE tool\\n");
    const events = parseSSE(body);
    const content = events.map((e) => e.choices?.[0]?.delta?.content || "").join("");
    expect(content).toBe("partial answer");

    const errorEvent = events.find((e) => e.error);
    expect(errorEvent?.error?.message).toContain("unsupported IDE tool");
    expect(events.some((e) => e.choices?.[0]?.finish_reason === "stop")).toBe(false);
  });

  it("drops frames batched behind an unsupported exec request in the same read", async () => {
    const { result } = await runAgent({
      frames: [Buffer.concat([execRequestFrame(2), textFrame("late")])],
      stream: true,
    });

    const body = await result.response.text();
    expect(body).toContain("unsupported IDE tool");
    expect(body).not.toContain("late");
  });

  it("returns a non-200 error body for an unsupported exec request when not streaming", async () => {
    const { result } = await runAgent({
      frames: [execRequestFrame(11)],
      stream: false,
    });

    expect(result.response.status).not.toBe(200);
    const payload = await result.response.json();
    expect(payload.error.message).toContain("unsupported IDE tool");
  });
});
