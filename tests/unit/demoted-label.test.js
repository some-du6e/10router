import { describe, expect, it } from "vitest";
import { DEMOTE_PREFIX, demotedLabel, demotedModels, isDemotionError } from "../../src/shared/utils/connectionStatus.js";
import { AUTH_DEMOTE_PREFIX } from "../../src/lib/db/repos/connectionsRepo.js";
import { withToggledActive } from "../../src/app/(dashboard)/dashboard/providers/utils.js";

const NOW = new Date("2026-11-02T14:40:00.000Z").getTime();
const at = (ms) => new Date(NOW + ms).toISOString();
const OPUS = `${AUTH_DEMOTE_PREFIX}claude-opus-5-5`;
const KIMI = `${AUTH_DEMOTE_PREFIX}kimi-k3`;
const REFUSED = '403 "Not authorized for this endpoint"';
const demoted = (extra = {}) => ({ count: 37, firstAt: at(-13 * 3600e3), demotedAt: at(-12 * 3600e3), reason: REFUSED, nextProbeAt: at(3 * 3600e3), ...extra });

describe("demoted key label", () => {
  it("uses the repo's record prefix", () => {
    expect(DEMOTE_PREFIX).toBe(AUTH_DEMOTE_PREFIX);
  });

  it("names the model, its refusal, and when it is next tested", () => {
    const label = demotedLabel({ [OPUS]: demoted(), [KIMI]: { count: 1, firstAt: at(-60e3) } }, NOW);
    expect(label.text).toBe("Demoted on claude-opus-5-5");
    expect(label.title).toBe(`Other keys go first on claude-opus-5-5 after repeated ${REFUSED}; not tested there again before ${new Date(NOW + 3 * 3600e3).toLocaleString()}`);
  });

  it("gives each demoted model its own refusal and test time", () => {
    const label = demotedLabel({ [OPUS]: demoted(), [KIMI]: demoted({ reason: "403 \"Forbidden\"", nextProbeAt: at(60e3) }) }, NOW);
    expect(label.text).toBe("Demoted on claude-opus-5-5, kimi-k3");
    expect(label.title.split("\n")).toEqual([
      `Other keys go first on claude-opus-5-5 after repeated ${REFUSED}; not tested there again before ${new Date(NOW + 3 * 3600e3).toLocaleString()}`,
      `Other keys go first on kimi-k3 after repeated 403 "Forbidden"; not tested there again before ${new Date(NOW + 60e3).toLocaleString()}`,
    ]);
  });

  it("waits for the last probe's lease as well as nextProbeAt", () => {
    const label = demotedLabel({ [OPUS]: demoted({ nextProbeAt: at(-60e3), leaseUntil: at(5 * 60e3) }) }, NOW);
    expect(label.title).toContain(`before ${new Date(NOW + 5 * 60e3).toLocaleString()}`);
  });

  it("says a due test happens on the next request, not a time in the past", () => {
    expect(demotedLabel({ [OPUS]: demoted({ nextProbeAt: at(-60e3) }) }, NOW).title).toMatch(/; tested on its next request for this model$/);
    expect(demotedLabel({ [OPUS]: demoted({ nextProbeAt: undefined }) }, NOW).title).toMatch(/; tested on its next request for this model$/);
    expect(demotedLabel({ [OPUS]: demoted({ nextProbeAt: "garbage", leaseUntil: at(60e3) }) }, NOW).title).toContain(`before ${new Date(NOW + 60e3).toLocaleString()}`);
  });

  it("falls back to 'refusals' for a record with no reason", () => {
    expect(demotedLabel({ [OPUS]: demoted({ reason: undefined }) }, NOW).title).toContain("after repeated refusals;");
  });

  it("shows nothing for a key still counting refusals, one a success cleared, or one turned off", () => {
    expect(demotedLabel({ [OPUS]: { count: 3, firstAt: at(-60e3) } }, NOW)).toBeNull();
    expect(demotedLabel({ [OPUS]: null }, NOW)).toBeNull();
    expect(demotedLabel({ isActive: false, [OPUS]: demoted() }, NOW)).toBeNull();
    expect(demotedLabel({}, NOW)).toBeNull();
    expect(demotedLabel(null, NOW)).toBeNull();
    expect(demotedModels({ [OPUS]: demoted() }).map(d => d.model)).toEqual(["claude-opus-5-5"]);
  });

  it("recognises the lastError written at demotion, which the label replaces", () => {
    const conn = { [OPUS]: demoted() };
    expect(isDemotionError(conn, `claude-opus-5-5 demoted after repeated ${REFUSED}`)).toBe(true);
    expect(isDemotionError(conn, '[403]: {"code":"003001","message":"Not authorized for this endpoint"}')).toBe(false);
    expect(isDemotionError({ [OPUS]: null }, `claude-opus-5-5 demoted after repeated ${REFUSED}`)).toBe(false);
  });
});

describe("toggling a demoted key", () => {
  it("takes the demotions the server kept", () => {
    const local = { id: "k", isActive: false, [OPUS]: demoted() };
    // Turning a key back on deletes its demotions on the server.
    const on = withToggledActive(local, true, { id: "k", isActive: true, [OPUS]: null });
    expect(demotedLabel(on, NOW)).toBeNull();
    const kept = withToggledActive({ id: "k", isActive: true, [OPUS]: demoted() }, false, { id: "k", isActive: false, [OPUS]: demoted() });
    expect(kept[OPUS].demotedAt).toBeTruthy();
  });

  it("keeps local demotions when the server sent no row back", () => {
    expect(withToggledActive({ id: "k", isActive: true, [OPUS]: demoted() }, true, undefined)[OPUS].demotedAt).toBeTruthy();
  });
});
