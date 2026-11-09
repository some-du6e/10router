// The endpoint page's Re-detect box: what it says and what it ticks.
import { describe, it, expect } from "vitest";
import { defaultPick, failedText, keyUrlNote, summaryText, unchangedText } from "../../src/app/(dashboard)/dashboard/providers/[id]/redetectText.ts";

const diff = (over = {}) => ({ ok: true, protocol: null, baseUrl: null, addModels: [], removeModels: [], outdatedModels: [], quirks: {}, modelsNote: null, changes: 0, ...over });

describe("Re-detect box text", () => {
  it("ends the error in one period", () => {
    expect(failedText(diff({ ok: false, error: "The key was rejected." }))).toBe("The key was rejected. Nothing was changed.");
    expect(failedText(diff({ ok: false, error: "No answer" }))).toBe("No answer. Nothing was changed.");
    expect(failedText(diff({ ok: false }))).toBe("Nothing was changed.");
  });

  it("doesn't claim the endpoint's URL was asked when one key's own URL was", () => {
    expect(unchangedText("all", false)).toMatch(/URL/);
    expect(unchangedText("all", true)).not.toMatch(/URL/);
    expect(unchangedText("endpoint", true)).not.toMatch(/URL/);
    expect(summaryText("models", diff({ viaKeyUrl: true }))).toBe(`No new models. ${keyUrlNote("models", false)}`);
  });

  it("says when the endpoint's URL was asked and its keys didn't get through", () => {
    expect(keyUrlNote("all", true)).toMatch(/^The keys on the endpoint's URL didn't get through/);
    expect(keyUrlNote("all", false)).toMatch(/^Checked through one key's own URL/);
    expect(summaryText("all", diff({ viaKeyUrl: true, otherKeysFailed: 2, baseKeysFailed: 2 })))
      .toBe(`Same API, no new models. ${keyUrlNote("all", true)} 2 other keys didn't get through.`);
  });

  it("counts the other keys that didn't get through", () => {
    expect(summaryText("models", diff({ otherKeysFailed: 1 }))).toBe("Same models as you have now. 1 other key didn't get through.");
    expect(summaryText("models", diff())).toBe("Same models as you have now.");
  });

  it("says why the model checks stopped early", () => {
    expect(summaryText("models", diff({ partialReason: "Detection ran out of time, so some models weren't checked." })))
      .toBe("Same models as you have now. Detection ran out of time, so some models weren't checked.");
  });

  it("says a keyless check only saw what's public, and nothing about it once there are changes", () => {
    expect(summaryText("models", diff({ usedKey: false }))).toBe("Same models as you have now. No key, so only what's public was checked.");
    expect(summaryText("models", diff({ usedKey: false, changes: 1 }))).toBe("Pick what to apply. Free probes only, nothing was generated.");
  });
});

describe("Re-detect box default ticks", () => {
  const switchable = { protocol: { from: "openai-chat", to: "openai-responses", applicable: true } };
  it("ticks an API switch the endpoint's URL answered", () => {
    expect(defaultPick(diff(switchable)).protocol).toBe(true);
  });
  it("leaves an API switch seen through one key's own URL unticked", () => {
    expect(defaultPick(diff({ ...switchable, viaKeyUrl: true })).protocol).toBe(false);
  });
  it("ticks new and gone models, never outdated ones", () => {
    expect(defaultPick(diff({ addModels: ["a"], removeModels: ["b"], outdatedModels: ["c"] }))).toMatchObject({ add: true, remove: true, outdated: false, quirks: true });
  });
});
