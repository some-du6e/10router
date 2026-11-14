import { describe, expect, it } from "vitest";
import { demotedLabel, demotedModels, isDemotionError } from "../../src/shared/utils/connectionStatus.js";
// Keys built the way the repo writes them.
import { getAuthDemoteKey, getAuthSoftKey } from "../../src/lib/db/repos/connectionsRepo.js";
import { withToggledActive } from "../../src/app/(dashboard)/dashboard/providers/utils.js";

const OPUS = getAuthDemoteKey("claude-opus-5-5");
const KIMI = getAuthDemoteKey("kimi-k3");
const REFUSED = '403 "Not authorized for this endpoint"';
const demoted = (extra = {}) => ({ count: 37, firstAt: "2026-11-02T01:28:10.416Z", demotedAt: "2026-11-02T02:29:57.665Z", reason: REFUSED, nextProbeAt: "2026-11-02T17:33:27.858Z", ...extra });

describe("demoted key label", () => {
  it("names the model and its refusal", () => {
    const label = demotedLabel({ [OPUS]: demoted(), [KIMI]: { count: 1, firstAt: "2026-11-02T03:31:00.000Z" } });
    expect(label).toEqual({
      text: "Demoted on claude-opus-5-5",
      title: `Demoted on claude-opus-5-5 after repeated ${REFUSED}. Switching the key off and on clears it.`,
    });
  });

  it("lists only models with a demotion", () => {
    expect(demotedModels({ [OPUS]: demoted(), [KIMI]: { count: 2 } })).toEqual([{ model: "claude-opus-5-5", reason: REFUSED }]);
  });

  it("gives each demoted model its own refusal", () => {
    const label = demotedLabel({ [OPUS]: demoted(), [KIMI]: demoted({ reason: '403 "Forbidden"' }) });
    expect(label.text).toBe("Demoted on claude-opus-5-5, kimi-k3");
    expect(label.title.split("\n")).toEqual([
      `Demoted on claude-opus-5-5 after repeated ${REFUSED}. Switching the key off and on clears it.`,
      'Demoted on kimi-k3 after repeated 403 "Forbidden". Switching the key off and on clears it.',
    ]);
  });

  it("falls back to 'refusals' for a record with no reason", () => {
    expect(demotedLabel({ [OPUS]: demoted({ reason: undefined }) }).title).toBe("Demoted on claude-opus-5-5 after repeated refusals. Switching the key off and on clears it.");
  });

  it("shows nothing for a key still counting refusals, one a success cleared, or one turned off", () => {
    expect(demotedLabel({ [OPUS]: { count: 3, firstAt: "2026-11-02T01:28:10.416Z" } })).toBeNull();
    expect(demotedLabel({ [OPUS]: null })).toBeNull();
    expect(demotedLabel({ isActive: false, [OPUS]: demoted() })).toBeNull();
    expect(demotedLabel({ "modelLock_claude-opus-5-5": demoted() })).toBeNull();
    expect(demotedLabel({})).toBeNull();
    expect(demotedLabel(null)).toBeNull();
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

describe("soft-demoted key label", () => {
  const SOFT_OPUS = getAuthSoftKey("claude-opus-5-5");
  const SOFT_KIMI = getAuthSoftKey("kimi-k3");
  const soft = (lastRefusedAt = "2026-11-02T02:40:00.000Z") => ({ level: 1, since: "2026-11-02T02:20:00.000Z", tryAt: "2026-11-02T03:00:00.000Z", lastRefusedAt });

  it("names the models and when the key was last refused there", () => {
    const label = demotedLabel({ [SOFT_OPUS]: soft() });
    expect(label.text).toBe("Soft-demoted on claude-opus-5-5");
    expect(label.title).toBe(`Soft-demoted on claude-opus-5-5: last refused ${new Date("2026-11-02T02:40:00.000Z").toLocaleString()}. `
      + "Other keys go first there until it serves claude-opus-5-5 again. Switching the key off and on clears it.");
    expect(demotedModels({ [SOFT_OPUS]: soft() })).toEqual([{ model: "claude-opus-5-5", soft: true, lastRefusedAt: "2026-11-02T02:40:00.000Z", keyRefused: false }]);
  });

  it("doesn't suggest replacing a key refused for itself that has served something since", () => {
    const label = demotedLabel({ [SOFT_OPUS]: { ...soft(), keyRefused: true }, authServedAt: "2026-11-02T02:50:00.000Z" });
    expect(label.title).not.toContain("replace the key");
  });

  // A soft demotion beginning on another model writes authDemoteOkAt too.
  it("still suggests replacing it when it has only been soft-demoted elsewhere since", () => {
    const label = demotedLabel({ [SOFT_OPUS]: { ...soft(), keyRefused: true }, authDemoteOkAt: "2026-11-02T02:50:00.000Z" });
    expect(label.title).toContain("replace the key");
  });

  it("suggests replacing a key whose refusals are of the key itself", () => {
    expect(demotedLabel({ [SOFT_OPUS]: { ...soft(), keyRefused: true } }).title).toBe(
      `Soft-demoted on claude-opus-5-5: last refused ${new Date("2026-11-02T02:40:00.000Z").toLocaleString()}. `
      + "Other keys go first there until it serves claude-opus-5-5 again. The upstream keeps refusing the key itself: if that goes on, "
      + "replace the key. Switching the key off and on clears it.");
  });

  it("lists demotions and soft demotions together", () => {
    expect(demotedLabel({ [OPUS]: demoted(), [SOFT_KIMI]: soft() }).text).toBe("Demoted on claude-opus-5-5, soft-demoted on kimi-k3");
    expect(demotedLabel({ isActive: false, [SOFT_KIMI]: soft() })).toBeNull();
    expect(demotedLabel({ [SOFT_KIMI]: null })).toBeNull();
  });

  it("follows the server's soft demotions on a toggle", () => {
    expect(demotedLabel(withToggledActive({ id: "k", isActive: false, [SOFT_OPUS]: soft() }, true, { id: "k", isActive: true }))).toBeNull();
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

  it("drops a local demotion the server row no longer has", () => {
    expect(withToggledActive({ id: "k", isActive: false, [OPUS]: demoted() }, true, { id: "k", isActive: true })[OPUS]).toBeNull();
  });

  it("keeps local demotions when the server sent no row back", () => {
    expect(withToggledActive({ id: "k", isActive: true, [OPUS]: demoted() }, true, undefined)[OPUS].demotedAt).toBeTruthy();
  });
});
