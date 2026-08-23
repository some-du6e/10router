import { describe, expect, it } from "vitest";

import { FORMATS } from "../../open-sse/translator/formats.js";
import { handleBypassRequest } from "../../open-sse/utils/bypassHandler.js";

describe("Claude CLI bypass response format", () => {
  it("honors the /v1/messages format for string-content validation probes", async () => {
    const result = handleBypassRequest(
      {
        model: "bottom-of-the-barrel",
        max_tokens: 1,
        stream: false,
        messages: [{ role: "user", content: "count" }]
      },
      "bottom-of-the-barrel",
      "claude-cli/2.1.0",
      false,
      FORMATS.CLAUDE
    );

    const body = await result.response.json();
    expect(body.type).toBe("message");
    expect(body).not.toHaveProperty("choices");
    expect(body.usage).toEqual({ input_tokens: 0, output_tokens: 1 });
  });
});
