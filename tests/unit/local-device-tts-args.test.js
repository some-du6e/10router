import { beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";

const calls = [];
let failing = null;
vi.mock("node:child_process", () => ({
  execFile: (cmd, args, cb) => {
    if (cmd === "say") {
      const textFile = args[args.indexOf("-f") + 1];
      calls.push({ args, dir: path.dirname(textFile), text: fs.readFileSync(textFile, "utf8") });
    }
    if (cmd === failing) return cb(new Error(`${cmd} failed`));
    if (cmd === "ffmpeg") fs.writeFileSync(args[args.length - 1], "mp3");
    cb(null, { stdout: "", stderr: "" });
  },
}));

const { default: localDevice } = await import("../../open-sse/handlers/ttsProviders/localDevice.js");

describe("local-device TTS", () => {
  beforeEach(() => {
    calls.length = 0;
    failing = null;
  });

  it("passes option-like input to say as file text, never as an argument", async () => {
    const input = "-f/etc/passwd";
    await localDevice.synthesize(input, "Alex");

    const { args, text, dir } = calls.at(-1);
    expect(text).toBe(input);
    expect(args).not.toContain(input);
    expect(args).toEqual(["-v", "Alex", "-o", path.join(dir, "out.aiff"), "-f", path.join(dir, "in.txt")]);
    expect(fs.existsSync(dir)).toBe(false);
  });

  it("uses the default voice when none is given", async () => {
    const result = await localDevice.synthesize("héllo wörld", "");

    const { args, text, dir } = calls.at(-1);
    expect(text).toBe("héllo wörld");
    expect(args).toEqual(["-o", path.join(dir, "out.aiff"), "-f", path.join(dir, "in.txt")]);
    expect(result).toEqual({ base64: Buffer.from("mp3").toString("base64"), format: "mp3" });
  });

  it.each(["say", "ffmpeg"])("removes the temp dir when %s fails", async (cmd) => {
    failing = cmd;
    await expect(localDevice.synthesize("text", "Alex")).rejects.toThrow(`${cmd} failed`);

    const { dir } = calls.at(-1);
    expect(fs.existsSync(dir)).toBe(false);
  });
});
