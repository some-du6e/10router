// The endpoint page's Re-detect box: what it says and what it ticks.
import { describe, it, expect } from "vitest";
import { defaultPick, failedText, fixesList, keyUrlNote, summaryText, unchangedText } from "../../src/app/(dashboard)/dashboard/providers/[id]/redetectText.ts";

const diff = (over = {}) => ({ ok: true, protocol: null, baseUrl: null, addModels: [], removeModels: [], outdatedModels: [], quirks: {}, modelsNote: null, changes: 0, ...over });

describe("Re-detect box text", () => {
  it("ends the error in one period", () => {
    expect(failedText(diff({ ok: false, error: "The key was rejected." }))).toBe("The key was rejected. Nothing was changed.");
    expect(failedText(diff({ ok: false, error: "No answer" }))).toBe("No answer. Nothing was changed.");
    expect(failedText(diff({ ok: false }))).toBe("Nothing was changed.");
  });

  it("doesn't claim the endpoint's URL was asked when one key's own URL was", () => {
    expect(unchangedText("all", "none")).toMatch(/URL/);
    expect(unchangedText("all", "account")).not.toMatch(/URL/);
    expect(unchangedText("endpoint", "account")).not.toMatch(/URL/);
    expect(summaryText("models", diff({ viaKeyUrl: true, keyScoped: true }))).toBe(`No new models. ${keyUrlNote("models", false, "account")}`);
  });

  it("says when the endpoint's URL was asked and its keys didn't give a full answer", () => {
    expect(keyUrlNote("all", true, "account")).toMatch(/^The keys on the endpoint's URL didn't give a full answer/);
    expect(keyUrlNote("all", false, "account")).toMatch(/^Checked through one key's own URL/);
    expect(summaryText("all", diff({ viaKeyUrl: true, keyScoped: true, otherKeysFailed: 2, baseKeysTried: 2 })))
      .toBe(`No new models. ${keyUrlNote("all", true, "account")} 2 other keys didn't get through.`);
    // Nor that the API or fixes were checked.
    expect(unchangedText("endpoint", "account")).toBe("Nothing to change.");
    expect(keyUrlNote("endpoint", false, "account")).toMatch(/the API, URL changes and fixes weren't checked/);
  });

  it("counts the other keys that didn't get through", () => {
    expect(summaryText("models", diff({ otherKeysFailed: 1 }))).toBe("Same models as you have now. 1 other key didn't get through.");
    expect(summaryText("models", diff())).toBe("Same models as you have now.");
  });

  it("says when a fallback key's list wasn't used to remove models", () => {
    expect(summaryText("models", diff({ removalsHeld: true, otherKeysFailed: 1 })))
      .toBe("No new models. Models missing from this key's list aren't offered for removal: another key comes first, and lists can differ by key. Switch off keys that don't work to get them. 1 other key didn't get through.");
  });

  it("when every key has its own URL, claims all but the URL and removals", () => {
    const own = { viaKeyUrl: true };
    expect(summaryText("endpoint", diff(own))).toBe(`No changes to the API or fixes. ${keyUrlNote("endpoint", false, "url")}`);
    expect(keyUrlNote("endpoint", false, "url")).toBe("No key uses the endpoint's URL, so this was checked through one key's own URL, and URL changes weren't checked.");
    expect(summaryText("models", diff(own))).toMatch(/^No new models\. No key uses the endpoint's URL/);
    expect(unchangedText("all", "url")).toBe("Same API, no new models.");
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

describe("Re-detect box fixes row", () => {
  it("lists each fix, and never an empty route map", () => {
    expect(fixesList({ maxCompletionTokens: true, apiKeyHeader: "api-key", modelRoutes: { a: "anthropic" } }))
      .toEqual(["send max_completion_tokens", "send the key in an api-key header", "send each model to the API that answers it"]);
    expect(fixesList({ modelRoutes: {} })).toEqual([]);
    expect(fixesList({})).toEqual([]);
  });
});

describe("Re-detect box default ticks", () => {
  const switchable = { protocol: { from: "openai-chat", to: "openai-responses", applicable: true } };
  it("ticks an API switch the endpoint's URL answered", () => {
    expect(defaultPick(diff(switchable)).protocol).toBe(true);
  });
  it("ticks new and gone models, never outdated ones", () => {
    expect(defaultPick(diff({ addModels: ["a"], removeModels: ["b"], outdatedModels: ["c"] }))).toMatchObject({ add: true, remove: true, outdated: false, quirks: true });
  });
});
