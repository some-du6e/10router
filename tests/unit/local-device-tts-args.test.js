import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";

const calls = [];
vi.mock("node:child_process", () => ({
  execFile: (cmd, args, cb) => {
    if (cmd === "say") {
      const textFile = args[args.indexOf("-f") + 1];
      calls.push({ args, text: fs.readFileSync(textFile, "utf8") });
    }
    if (cmd === "ffmpeg") fs.writeFileSync(args[args.length - 1], "mp3");
    cb(null, { stdout: "", stderr: "" });
  },
}));

const { default: localDevice } = await import("../../open-sse/handlers/ttsProviders/localDevice.js");

describe("local-device TTS", () => {
  it("passes option-like input to say as file text, never as an argument", async () => {
    const input = "-f/etc/passwd";
    await localDevice.synthesize(input, "Alex");

    const { args, text } = calls.at(-1);
    expect(text).toBe(input);
    expect(args).not.toContain(input);
    expect(args.slice(0, 2)).toEqual(["-v", "Alex"]);
  });
});
