import { describe, expect, it } from "vitest";
import { demotedLabel, demotedModels } from "../../src/shared/utils/connectionStatus.js";

const record = (extra = {}) => ({ count: 37, firstAt: "2026-11-02T01:28:10.416Z", reason: '403 "Not authorized for this endpoint"', ...extra });

describe("demoted key label", () => {
  it("names the models a key is demoted on", () => {
    const conn = {
      "authDemote_claude-opus-5-5": record({ demotedAt: "2026-11-02T02:29:57.665Z", nextProbeAt: "2026-11-02T17:33:27.858Z" }),
      "authDemote_kimi-k3": record(),
    };
    expect(demotedModels(conn).map(d => d.model)).toEqual(["claude-opus-5-5"]);
    const label = demotedLabel(conn);
    expect(label.text).toBe("Demoted on claude-opus-5-5");
    expect(label.title).toContain('403 "Not authorized for this endpoint"');
    expect(label.title).toContain("next test");
  });

  it("shows nothing for a key that is only counting refusals, or whose record a success cleared", () => {
    expect(demotedLabel({ "authDemote_claude-opus-5-5": record() })).toBeNull();
    expect(demotedLabel({ "authDemote_claude-opus-5-5": null })).toBeNull();
    expect(demotedLabel({})).toBeNull();
    expect(demotedLabel(null)).toBeNull();
  });
});
