import { describe, expect, it } from "vitest";
import { DEMOTE_PREFIX, demotedLabel, demotedModels, isDemotionError } from "../../src/shared/utils/connectionStatus.js";
import { AUTH_DEMOTE_PREFIX, getAuthDemoteKey } from "../../src/lib/db/repos/connectionsRepo.js";
import { withToggledActive } from "../../src/app/(dashboard)/dashboard/providers/utils.js";

const OPUS = getAuthDemoteKey("claude-opus-5-5");
const KIMI = getAuthDemoteKey("kimi-k3");
const REFUSED = '403 "Not authorized for this endpoint"';
const demoted = (extra = {}) => ({ count: 37, firstAt: "2026-11-02T01:28:10.416Z", demotedAt: "2026-11-02T02:29:57.665Z", reason: REFUSED, nextProbeAt: "2026-11-02T17:33:27.858Z", ...extra });

describe("demoted key label", () => {
  it("reads the records the repo writes", () => {
    expect(AUTH_DEMOTE_PREFIX).toBe(DEMOTE_PREFIX);
  });

  it("names the model and its refusal", () => {
    const label = demotedLabel({ [OPUS]: demoted(), [KIMI]: { count: 1, firstAt: "2026-11-02T03:31:00.000Z" } });
    expect(label).toEqual({
      text: "Demoted on claude-opus-5-5",
      title: `Demoted on claude-opus-5-5 after repeated ${REFUSED}: other keys are used first while they can serve it`,
    });
  });

  it("gives each demoted model its own refusal", () => {
    const label = demotedLabel({ [OPUS]: demoted(), [KIMI]: demoted({ reason: '403 "Forbidden"' }) });
    expect(label.text).toBe("Demoted on claude-opus-5-5, kimi-k3");
    expect(label.title.split("\n")).toEqual([
      `Demoted on claude-opus-5-5 after repeated ${REFUSED}: other keys are used first while they can serve it`,
      'Demoted on kimi-k3 after repeated 403 "Forbidden": other keys are used first while they can serve it',
    ]);
  });

  it("falls back to 'refusals' for a record with no reason", () => {
    expect(demotedLabel({ [OPUS]: demoted({ reason: undefined }) }).title).toContain("after repeated refusals:");
  });

  it("shows nothing for a key still counting refusals, one a success cleared, or one turned off", () => {
    expect(demotedLabel({ [OPUS]: { count: 3, firstAt: "2026-11-02T01:28:10.416Z" } })).toBeNull();
    expect(demotedLabel({ [OPUS]: null })).toBeNull();
    expect(demotedLabel({ isActive: false, [OPUS]: demoted() })).toBeNull();
    expect(demotedLabel({ "modelLock_claude-opus-5-5": demoted() })).toBeNull();
    expect(demotedLabel({})).toBeNull();
    expect(demotedLabel(null)).toBeNull();
    expect(demotedModels({ [OPUS]: demoted() }).map(d => d.model)).toEqual(["claude-opus-5-5"]);
  });

  it("recognises the lastError written at demotion, which the label replaces or which is stale", () => {
    const message = `claude-opus-5-5 demoted after repeated ${REFUSED}`;
    expect(isDemotionError({ [OPUS]: demoted(), lastError: message })).toBe(true);
    // Turned back on or served since: the record is gone and the message no longer holds.
    expect(isDemotionError({ [OPUS]: null, lastError: message })).toBe(true);
    expect(isDemotionError({ lastError: '[403]: {"code":"003001","message":"Not authorized for this endpoint"}' })).toBe(false);
    expect(isDemotionError({ lastError: "Request demoted after repeated retries" })).toBe(false);
    expect(isDemotionError({ lastError: `upstream says: ${message}` })).toBe(false);
    expect(isDemotionError({})).toBe(false);
    expect(isDemotionError(null)).toBe(false);
  });
});

describe("toggling a demoted key", () => {
  it("takes the demotions the server kept", () => {
    // Turning a key back on deletes its demotions on the server.
    const on = withToggledActive({ id: "k", isActive: false, [OPUS]: demoted() }, true, { id: "k", isActive: true, [OPUS]: null });
    expect(demotedLabel(on)).toBeNull();
    const kept = withToggledActive({ id: "k", isActive: true, [OPUS]: demoted() }, false, { id: "k", isActive: false, [OPUS]: demoted() });
    expect(kept[OPUS].demotedAt).toBeTruthy();
  });

  it("picks up a demotion the server wrote after the page loaded", () => {
    const off = withToggledActive({ id: "k", isActive: true }, false, { id: "k", isActive: false, [KIMI]: demoted() });
    expect(off[KIMI].demotedAt).toBeTruthy();
  });

  it("keeps local demotions when the server sent no row back", () => {
    expect(withToggledActive({ id: "k", isActive: true, [OPUS]: demoted() }, true, undefined)[OPUS].demotedAt).toBeTruthy();
  });
});
