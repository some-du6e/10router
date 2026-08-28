import { describe, it, expect } from "vitest";
import {
  isLimitError,
  formatDuration,
  buildBannerText,
  LIMIT_HOLD_SENTINEL,
  createLimitHoldResponse,
} from "open-sse/utils/limitHold.js";
import { hasLimitHoldBanner, injectLimitHoldNotice } from "open-sse/utils/limitHoldNotice.js";
import { FORMATS } from "open-sse/translator/formats.js";

describe("isLimitError", () => {
  it("holds on rate/quota failures", () => {
    expect(isLimitError(429, "too many requests")).toBe(true);
    expect(isLimitError(403, "usage_limit_reached")).toBe(true);
    expect(isLimitError(400, "quota exceeded")).toBe(true);
  });

  it("does not hold on faults the wait would never fix", () => {
    expect(isLimitError(401, "invalid api key")).toBe(false);
    expect(isLimitError(500, "internal error")).toBe(false);
    expect(isLimitError(503, "upstream unavailable")).toBe(false);
  });
});

describe("formatDuration", () => {
  it("renders human spans", () => {
    expect(formatDuration(45_000)).toBe("45s");
    expect(formatDuration(90_000)).toBe("1m");
    expect(formatDuration(8_040_000)).toBe("2h 14m");
    expect(formatDuration(90_000_000)).toBe("1d 1h");
  });
});

describe("banner", () => {
  it("carries the sentinel so the next turn can detect it", () => {
    const text = buildBannerText({ provider: "codex", waitMs: 8_040_000, attempt: 1 });
    expect(text).toContain(LIMIT_HOLD_SENTINEL);
    expect(text).toContain("codex limit reached");
    expect(text).toContain("2h 14m");
  });
});

describe("banner detection", () => {
  it("finds a banner in assistant history", () => {
    const body = { messages: [{ role: "assistant", content: `hi ${LIMIT_HOLD_SENTINEL} there` }] };
    expect(hasLimitHoldBanner(body)).toBe(true);
  });

  it("ignores a user pasting the marker", () => {
    const body = { messages: [{ role: "user", content: `what is ${LIMIT_HOLD_SENTINEL}?` }] };
    expect(hasLimitHoldBanner(body)).toBe(false);
  });

  it("reads claude block arrays", () => {
    const body = { messages: [{ role: "assistant", content: [{ type: "text", text: LIMIT_HOLD_SENTINEL }] }] };
    expect(hasLimitHoldBanner(body)).toBe(true);
  });

  it("does not infer model from a role-less gemini contents entry", () => {
    // Gemini defaults an omitted contents[] role to user, so a banner-quoting
    // user turn must not trigger the notice.
    const body = { contents: [{ parts: [{ text: LIMIT_HOLD_SENTINEL }] }] };
    expect(hasLimitHoldBanner(body)).toBe(false);
    expect(injectLimitHoldNotice(body, FORMATS.GEMINI)).toBe(body);
  });
});

describe("system turn injection", () => {
  const dirty = { messages: [{ role: "assistant", content: LIMIT_HOLD_SENTINEL }] };

  it("is a no-op without a banner", () => {
    const clean = { messages: [{ role: "user", content: "hello" }] };
    expect(injectLimitHoldNotice(clean, FORMATS.OPENAI)).toBe(clean);
  });

  it("adds an openai system message ahead of the history", () => {
    const out = injectLimitHoldNotice(dirty, FORMATS.OPENAI);
    expect(out.messages[0].role).toBe("system");
    expect(out.messages[0].content).toContain(LIMIT_HOLD_SENTINEL);
    expect(dirty.messages).toHaveLength(1); // original untouched
  });

  it("keeps the caller's own system prompt first", () => {
    const body = { messages: [{ role: "system", content: "be terse" }, ...dirty.messages] };
    const out = injectLimitHoldNotice(body, FORMATS.OPENAI);
    expect(out.messages[0].content).toBe("be terse");
    expect(out.messages[1].role).toBe("system");
  });

  it("appends to claude's top-level system field", () => {
    const out = injectLimitHoldNotice({ ...dirty, system: "base" }, FORMATS.CLAUDE);
    expect(out.system).toContain("base");
    expect(out.system).toContain(LIMIT_HOLD_SENTINEL);
    expect(Array.isArray(out.messages)).toBe(true);
  });

  it("appends to a claude system block array", () => {
    const out = injectLimitHoldNotice({ ...dirty, system: [{ type: "text", text: "base" }] }, FORMATS.CLAUDE);
    expect(out.system).toHaveLength(2);
    expect(out.system[1].text).toContain(LIMIT_HOLD_SENTINEL);
  });

  it("uses systemInstruction for gemini", () => {
    const out = injectLimitHoldNotice(dirty, FORMATS.GEMINI);
    expect(out.systemInstruction.parts[0].text).toContain(LIMIT_HOLD_SENTINEL);
  });

  it("does not leave a stale snake_case systemInstruction behind", () => {
    const body = { ...dirty, system_instruction: { role: "system", parts: [{ text: "base" }] } };
    const out = injectLimitHoldNotice(body, FORMATS.GEMINI);
    expect(out.system_instruction).toBeUndefined();
    expect(out.systemInstruction.parts).toHaveLength(2);
    expect(out.systemInstruction.parts[1].text).toContain(LIMIT_HOLD_SENTINEL);
  });

  it("uses instructions for the responses api", () => {
    const out = injectLimitHoldNotice(dirty, FORMATS.OPENAI_RESPONSES);
    expect(out.instructions).toContain(LIMIT_HOLD_SENTINEL);
  });
});

async function readAll(response, { limit = 50 } = {}) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let out = "";
  for (let i = 0; i < limit; i++) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  return out;
}

describe("multi-byte splice", () => {
  it("survives a UTF-8 sequence split across upstream chunks", async () => {
    const payload = `data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "日本語テキスト 🎉" } })}\n\n`;
    const full = new TextEncoder().encode(`event: content_block_delta\n${payload}`);
    const cut = 40; // lands mid-character
    const upstream = new Response(new ReadableStream({
      start(c) { c.enqueue(full.slice(0, cut)); c.enqueue(full.slice(cut)); c.close(); },
    }));

    const res = createLimitHoldResponse({
      sourceFormat: FORMATS.CLAUDE,
      model: "claude-sonnet-4",
      provider: "codex",
      retryAtMs: Date.now() + 5,
      attempt: async () => ({ success: true, response: upstream }),
      timing: { keepaliveMs: 5000, minWaitMs: 5, recheckMs: 5 },
    });

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let out = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      out += decoder.decode(value, { stream: true });
    }
    expect(out).toContain("日本語テキスト 🎉");
    expect(out).not.toContain("\uFFFD"); // no replacement chars
  }, 20000);
});

describe("awaitLimitClear", () => {
  it("gives up at the deadline instead of retrying forever", async () => {
    const { awaitLimitClear } = await import("open-sse/utils/limitHold.js");
    let calls = 0;
    const last = await awaitLimitClear({
      retryAtMs: Date.now(),
      attempt: async () => { calls += 1; return { success: false, status: 429, error: "usage_limit_reached" }; },
      provider: "codex",
      model: "gpt-5",
      timing: { minWaitMs: 1, recheckMs: 1, maxHoldMs: 30 },
    });
    expect(calls).toBeGreaterThan(0);
    expect(last).toMatchObject({ success: false, status: 429 });
  }, 20000);

  it("returns as soon as the limit clears", async () => {
    const { awaitLimitClear } = await import("open-sse/utils/limitHold.js");
    let calls = 0;
    const last = await awaitLimitClear({
      retryAtMs: Date.now(),
      attempt: async () => { calls += 1; return calls < 2 ? { success: false, status: 429, error: "rate limit" } : { success: true, response: new Response("ok") }; },
      provider: "codex",
      model: "gpt-5",
      timing: { minWaitMs: 1, recheckMs: 1, maxHoldMs: 10_000 },
    });
    expect(last.success).toBe(true);
    expect(calls).toBe(2);
  }, 20000);
});

describe("createLimitHoldResponse", () => {
  it("emits the banner immediately and splices the real stream after the wait", async () => {
    const upstream = new Response(
      new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "real answer" } }] })}\n\n`));
          c.close();
        },
      })
    );

    let calls = 0;
    const response = createLimitHoldResponse({
      sourceFormat: FORMATS.OPENAI,
      model: "gpt-5",
      provider: "codex",
      // Already elapsed → the MIN_WAIT floor applies, so we only assert the banner here.
      retryAtMs: Date.now(),
      attempt: async () => {
        calls += 1;
        return { success: true, response: upstream };
      },
    });

    expect(response.headers.get("Content-Type")).toBe("text/event-stream");
    const reader = response.body.getReader();
    const { value } = await reader.read();
    const first = new TextDecoder().decode(value);
    expect(first).toContain("codex limit reached");
    expect(first).toContain(LIMIT_HOLD_SENTINEL);
    await reader.cancel(); // client hangs up → timers released
    expect(calls).toBe(0);
  });

  it("stops holding when the failure is no longer a limit", async () => {
    const response = createLimitHoldResponse({
      sourceFormat: FORMATS.OPENAI,
      model: "gpt-5",
      provider: "codex",
      retryAtMs: Date.now() + 5,
      attempt: async () => ({ success: false, status: 401, error: "invalid api key" }),
    });
    const reader = response.body.getReader();
    const { value } = await reader.read();
    expect(new TextDecoder().decode(value)).toContain("codex limit reached");
    await reader.cancel();
  });
});

function claudeUpstream() {
  const events = [
    { type: "message_start", message: { id: "msg_real", role: "assistant", content: [], usage: { input_tokens: 5 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "real answer" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } },
    { type: "message_stop" },
  ];
  return new Response(new ReadableStream({
    start(c) {
      for (const e of events) c.enqueue(new TextEncoder().encode(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`));
      c.close();
    },
  }));
}

function responsesUpstream() {
  const events = [
    { event: "response.created", data: { type: "response.created", response: { id: "resp_real", output: [] }, sequence_number: 1 } },
    { event: "response.output_item.added", data: { type: "response.output_item.added", output_index: 0, item: { id: "m0", type: "message", role: "assistant", content: [] }, sequence_number: 2 } },
    { event: "response.output_text.delta", data: { type: "response.output_text.delta", item_id: "m0", output_index: 0, content_index: 0, delta: "real answer", sequence_number: 3 } },
    { event: "response.completed", data: { type: "response.completed", response: { id: "resp_real", status: "completed" }, sequence_number: 4 } },
  ];
  return new Response(new ReadableStream({
    start(c) {
      for (const e of events) c.enqueue(new TextEncoder().encode(`event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`));
      c.close();
    },
  }));
}

async function drain(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let out = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  return out;
}

describe("openai-responses splice", () => {
  it("keeps one response envelope and shifts output indices past the banner", async () => {
    const out = await drain(createLimitHoldResponse({
      sourceFormat: FORMATS.OPENAI_RESPONSES,
      model: "gpt-5",
      provider: "codex",
      retryAtMs: Date.now() + 5,
      attempt: async () => ({ success: true, response: responsesUpstream() }),
      timing: { keepaliveMs: 5000, minWaitMs: 5, recheckMs: 5 },
    }));

    const types = out.split("\n\n").filter(Boolean).map(c => {
      const m = c.match(/^event: (.*)\ndata: (.*)$/s);
      return m ? { type: m[1], data: JSON.parse(m[2]) } : null;
    }).filter(Boolean);

    expect(types.filter(e => e.type === "response.created")).toHaveLength(1);
    expect(types.filter(e => e.type === "response.completed")).toHaveLength(1);
    // banner occupies output_index 0, real content is pushed to 1
    const realDelta = types.find(e => e.type === "response.output_text.delta" && e.data.delta === "real answer");
    expect(realDelta.data.output_index).toBe(1);
    expect(out).toContain(LIMIT_HOLD_SENTINEL);
  }, 20000);
});

describe("openai passthrough splice", () => {
  it("concatenates without rewriting", async () => {
    const upstream = new Response(new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "real answer" } }] })}\n\n`));
        c.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
        c.close();
      },
    }));
    const out = await drain(createLimitHoldResponse({
      sourceFormat: FORMATS.OPENAI,
      model: "gpt-5",
      provider: "codex",
      retryAtMs: Date.now() + 5,
      attempt: async () => ({ success: true, response: upstream }),
      timing: { keepaliveMs: 5000, minWaitMs: 5, recheckMs: 5 },
    }));
    expect(out).toContain(LIMIT_HOLD_SENTINEL);
    expect(out).toContain("real answer");
    // exactly one terminator — the upstream's own
    expect(out.split("data: [DONE]").length - 1).toBe(1);
  }, 20000);
});

describe("claude splice", () => {
  it("emits one message envelope and non-colliding block indices", async () => {
    const response = createLimitHoldResponse({
      sourceFormat: FORMATS.CLAUDE,
      model: "claude-sonnet-4",
      provider: "codex",
      retryAtMs: Date.now() + 10,
      attempt: async () => ({ success: true, response: claudeUpstream() }),
      timing: { keepaliveMs: 5000, minWaitMs: 5, recheckMs: 5 },
    });

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let out = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      out += decoder.decode(value, { stream: true });
    }

    const events = out.split("\n\n").filter(c => c.startsWith("event:")).map(c => {
      const m = c.match(/^event: (.*)\ndata: (.*)$/s);
      return { type: m[1], data: JSON.parse(m[2]) };
    });

    console.log(events.map(e => `${e.type} idx=${e.data.index ?? "-"}`).join("\n"));

    const starts = events.filter(e => e.type === "message_start");
    expect(starts.length).toBe(1);

    const blockStarts = events.filter(e => e.type === "content_block_start").map(e => e.data.index);
    expect(new Set(blockStarts).size).toBe(blockStarts.length);

    expect(out).toContain(LIMIT_HOLD_SENTINEL);
    expect(out).toContain("real answer");
    expect(events.filter(e => e.type === "message_stop").length).toBe(1);
  }, 20000);
});
