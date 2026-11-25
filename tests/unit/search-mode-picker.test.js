import PropTypes from "prop-types";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as providers from "@/shared/constants/providers.js";
import * as searchModel from "../../src/shared/utils/searchModel.ts";
import { GET as modelInfo } from "../../src/app/api/v1/models/info/route.js";
import { dashboardComponent, elements, textContent } from "../helpers/dashboardComponent.js";

afterEach(() => vi.unstubAllGlobals());

// The values the combo page's Add Provider list offers for these connections.
function pickerValues(kindFilter, activeProviders) {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({})));
  const component = dashboardComponent("src/shared/components/ModelSelectModal.js", {
    "prop-types": { __esModule: true, default: PropTypes },
    "@/shared/constants/providers": providers,
    "@/shared/utils/searchModel.js": searchModel,
    "@/shared/hooks/useModelCaps": { useModelCaps: () => ({ getCaps: () => undefined }) },
    "@/shared/constants/models": { getModelsByProviderId: () => [], getModelKind: () => undefined },
  });
  const onSelect = vi.fn();
  const tree = component.render({ isOpen: true, onClose: vi.fn(), onSelect, kindFilter, activeProviders, closeOnSelect: false });
  for (const button of elements(tree, (element) => element.type === "button")) button.props.onClick();
  return onSelect.mock.calls.map(([model]) => model.value);
}

describe("search modes in the dashboard", () => {
  const connections = [{ provider: "exa", id: "exa-account" }, { provider: "hackclub-exa", id: "hc-account" }];

  it("offers each search mode in a Web Search combo's Add Provider list", () => {
    const values = pickerValues("webSearch", connections).filter((value) => value.includes("exa"));
    expect(values.sort()).toEqual([
      "exa", "exa/fast", "exa/instant", "exa/lite",
      "hackclub-exa", "hackclub-exa/fast", "hackclub-exa/instant", "hackclub-exa/lite",
    ]);
  });

  it("offers only the provider for Web Fetch", () => {
    expect(pickerValues("webFetch", connections).filter((value) => value.includes("exa"))).toEqual(["exa"]);
  });

  it("lists the modes on the provider's config card", () => {
    const card = dashboardComponent("src/shared/components/ProviderInfoCard.js");
    const text = textContent(card.render({ config: providers.AI_PROVIDERS.exa.searchConfig, provider: providers.AI_PROVIDERS.exa }));
    expect(text).toContain("Search modesauto, lite, fast, instant");
  });

  it("returns the modes from /v1/models/info", async () => {
    const info = await (await modelInfo(new Request("http://localhost/v1/models/info?id=hackclub-exa/search"))).json();
    expect(info).toMatchObject({
      id: "hackclub-exa/search",
      kind: "webSearch",
      modes: ["auto", "lite", "fast", "instant"],
      defaultMode: "auto",
    });
  });
});
