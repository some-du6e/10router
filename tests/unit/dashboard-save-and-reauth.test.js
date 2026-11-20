import { afterEach, describe, expect, it, vi } from "vitest";
import { dashboardComponent, elements, textContent } from "../helpers/dashboardComponent.js";
import api from "@/shared/utils/api.js";
import { authenticatedConnectionId, reauthOutcome } from "@/shared/utils/reauthOutcome.js";
import { POST as gitlabPat } from "../../src/app/api/oauth/gitlab/pat/route.js";
import PropTypes from "prop-types";

const { createConnection } = vi.hoisted(() => ({ createConnection: vi.fn() }));
vi.mock("@/models", () => ({ createProviderConnection: createConnection }));
vi.mock("next/server", () => ({ NextResponse: { json: (body, init) => Response.json(body, init) } }));

afterEach(() => {
  vi.unstubAllGlobals();
  createConnection.mockReset();
});
const imports = {
  "@/shared/utils/api": { __esModule: true, default: api },
  "prop-types": { __esModule: true, default: PropTypes },
};
const componentImports = {
  ...imports,
  "@/shared/components": {
    Card: "Card", Button: "Button", Modal: "Modal", Input: "Input", CardSkeleton: "CardSkeleton", ModelSelectModal: "ModelSelectModal",
    ConfirmModal: "ConfirmModal", CapacityBadges: "CapacityBadges", Select: "Select", Toggle: "Toggle", OAuthModal: "OAuthModal",
  },
  "@dnd-kit/core": { useSensors: () => [], useSensor: () => ({}) },
  "@/shared/hooks/useCopyToClipboard": { useCopyToClipboard: () => ({ copied: null, copy: () => {} }) },
  "@/shared/hooks/useModelCaps": { useModelCaps: () => ({ getCaps: () => ({}) }) },
};
const alerts = (tree) => elements(tree, (element) => element.props?.role === "alert").map(textContent).join(" ");
const selects = (tree) => elements(tree, (element) => element.type === "Select" || element.type === "select");
const saved = (tree) => elements(tree, (element) => element.type === "Badge" && textContent(element) === "Saved");
const button = (tree, text) => elements(tree, (element) => element.type === "Button" && textContent(element) === text)[0];
const proxyPath = "src/shared/components/NoAuthProxyCard.js";
const combosPath = "src/app/(dashboard)/dashboard/combos/page.js";
const pools = { proxyPools: [{ id: "pool-a", name: "A" }, { id: "pool-b", name: "B" }] };
const settings = { providerStrategies: { other: { proxyPoolId: "untouched" }, local: { proxyPoolId: "pool-a" } } };
const savedAccount = { connection: { id: "saved-account" } };

describe("combos page saves", () => {
  it("shows a rejected route-group combo save and permits retry", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ aliases: {} })));
    const component = dashboardComponent(combosPath, componentImports, "ComboFormModal");
    const props = { isOpen: true, combo: { name: " my-combo ", models: [] }, onSave: vi.fn().mockRejectedValueOnce(new Error("Write refused")).mockResolvedValueOnce(undefined) };
    const save = (tree) => elements(tree, (element) => element.type === "Button" && ["Save", "Saving..."].includes(textContent(element)))[0];
    await save(component.render(props)).props.onClick();
    expect(alerts(component.render(props))).toContain("Write refused");
    expect(save(component.render(props)).props.disabled).toBe(false);
    await save(component.render(props)).props.onClick();
    expect(props.onSave).toHaveBeenCalledTimes(2);
    expect(props.onSave).toHaveBeenLastCalledWith({ name: "my-combo", models: [] });
    expect(alerts(component.render(props))).toBe("");
  });

  it("keeps the route-group combo form open while a save is pending", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ aliases: {} })));
    const component = dashboardComponent(combosPath, componentImports, "ComboFormModal");
    let finishSave;
    const props = { isOpen: true, combo: { name: "my-combo", models: [] }, onClose: vi.fn(), onSave: vi.fn(() => new Promise((resolve) => { finishSave = resolve; })) };
    const saving = button(component.render(props), "Save").props.onClick();
    const tree = component.render(props);
    expect(button(tree, "Cancel").props.disabled).toBe(true);
    elements(tree, (element) => element.type === "Modal")[0].props.onClose();
    expect(props.onClose).not.toHaveBeenCalled();
    finishSave();
    await saving;
  });

  const combosPage = async (writeError, { write, settingsError } = {}) => {
    const fetch = vi.fn(async (url, init = {}) => {
      if (init.method && init.method !== "GET") {
        if (write) return write(init);
        return writeError ? Response.json({ error: writeError }, { status: 500 }) : Response.json({ success: true });
      }
      if (url === "/api/combos") return Response.json({ combos: [{ id: "combo-1", name: "alpha", models: ["provider/model"] }] });
      if (url === "/api/providers") return Response.json({ connections: [] });
      if (settingsError) return Response.json({ error: settingsError }, { status: 503 });
      return Response.json({ comboStrategies: {}, capacityAdapter: {} });
    });
    vi.stubGlobal("fetch", fetch);
    const page = dashboardComponent(combosPath, componentImports);
    page.render({});
    await vi.waitFor(() => expect(elements(page.render({}), (element) => element.props?.onSetStrategy)).toHaveLength(1));
    return { page, fetch, render: () => page.render({}) };
  };
  const card = (tree) => elements(tree, (element) => element.props?.onSetStrategy)[0];
  const capacity = (tree) => elements(tree, (element) => element.props?.capacityAdapter)[0];
  // Renders the page's capacity section, then one capability's card, from the page tree.
  const capacityCap = (tree, key) => {
    const section = dashboardComponent(combosPath, componentImports, "CapacityAdapterSection").render(capacity(tree).props);
    const { props } = elements(section, (element) => element.props?.cap?.key === key)[0];
    const component = dashboardComponent(combosPath, componentImports, "CapacityAdapterCap");
    return { render: () => component.render(props) };
  };
  const enableToggle = (tree) => elements(tree, (element) => element.type === "Toggle" && element.props["aria-label"]?.startsWith("Enable "))[0];
  const heldWrites = () => {
    const writes = [];
    const write = (init) => new Promise((resolve) => writes.push({
      body: JSON.parse(init.body),
      accept: () => resolve(Response.json({ success: true })),
      refuse: () => resolve(Response.json({ error: "Settings refused" }, { status: 500 })),
    }));
    return { writes, write };
  };
  const pickVisionModels = (tree, ...values) => {
    const vision = capacityCap(tree, "vision");
    button(vision.render(), "Add Model").props.onClick();
    const picker = elements(vision.render(), (element) => element.type === "ModelSelectModal")[0];
    expect(picker.props.closeOnSelect).toBe(false);
    values.forEach((value) => picker.props.onSelect({ value }));
  };

  it("blocks strategy and capacity saves, and says why, when settings fail to load", async () => {
    const { render, fetch } = await combosPage(null, { settingsError: "Settings unavailable" });
    expect(alerts(render())).toContain("Could not load combo settings");
    expect(alerts(render())).toContain("Settings unavailable");

    const comboCard = dashboardComponent(combosPath, componentImports, "ComboCard").render(card(render()).props);
    expect(elements(comboCard, (element) => element.type === "Select")[0].props.disabled).toBe(true);
    const vision = capacityCap(render(), "vision").render();
    expect(enableToggle(vision).props.disabled).toBe(true);
    expect(button(vision, "Add Model").props.disabled).toBe(true);

    await card(render()).props.onSetStrategy({ fallbackStrategy: "round-robin" });
    await enableToggle(vision).props.onChange(false);
    expect(fetch.mock.calls.filter(([, init]) => init?.method === "PATCH")).toEqual([]);
    expect(card(render()).props.strategy).toEqual({});
  });

  it("keeps every capacity change made while an earlier one is still saving", async () => {
    const { writes, write } = heldWrites();
    const { render } = await combosPage(null, { write });
    pickVisionModels(render(), "provider/first", "provider/second");
    enableToggle(capacityCap(render(), "audioInput").render()).props.onChange(false);
    for (let i = 0; i < 3; i += 1) {
      await vi.waitFor(() => expect(writes.length).toBeGreaterThan(i));
      writes[i].accept();
    }
    const expected = {
      vision: { enabled: true, roundRobin: false, models: ["provider/first", "provider/second"] },
      audioInput: { enabled: false, roundRobin: false, models: [] },
    };
    await vi.waitFor(() => expect(capacity(render()).props.capacityAdapter).toEqual(expected));
    expect(writes.at(-1).body).toEqual({ capacityAdapter: expected });
    expect(alerts(render())).toBe("");
  });

  it("builds a capacity change queued behind a failed save on the value saved before it", async () => {
    const { writes, write } = heldWrites();
    const { render } = await combosPage(null, { write });
    const before = capacity(render()).props.capacityAdapter;
    pickVisionModels(render(), "provider/refused", "provider/accepted");
    await vi.waitFor(() => expect(writes).toHaveLength(1));
    writes[0].refuse();
    await vi.waitFor(() => expect(writes).toHaveLength(2));
    expect(writes[1].body.capacityAdapter.vision.models).toEqual(["provider/accepted"]);
    expect(capacity(render()).props.capacityAdapter).toBe(before);
    expect(alerts(render())).toContain("Failed to update capacity adapter: Settings refused");
    writes[1].accept();
    await vi.waitFor(() => expect(capacity(render()).props.capacityAdapter.vision.models).toEqual(["provider/accepted"]));
  });

  it("rejects create and update when the API refuses them, keeping the form open", async () => {
    const { render } = await combosPage("Write refused");
    button(render(), "Create Combo").props.onClick();
    const createForm = elements(render(), (element) => element.key === "create")[0];
    await expect(createForm.props.onSave({ name: "beta", models: [] })).rejects.toThrow("Write refused");
    expect(elements(render(), (element) => element.key === "create")).toHaveLength(1);

    card(render()).props.onEdit();
    const editForm = elements(render(), (element) => element.key === "combo-1" && element.props.onSave)[0];
    await expect(editForm.props.onSave({ name: "alpha", models: [] })).rejects.toThrow("Write refused");
    expect(elements(render(), (element) => element.key === "combo-1" && element.props.onSave)).toHaveLength(1);
  });

  it("shows failed strategy, capacity and delete writes and keeps the saved values", async () => {
    const { render } = await combosPage("Settings refused");
    await card(render()).props.onSetStrategy({ fallbackStrategy: "round-robin" });
    expect(alerts(render())).toContain("Failed to update combo strategy: Settings refused");
    expect(card(render()).props.strategy).toEqual({});

    const before = capacity(render()).props.capacityAdapter;
    await enableToggle(capacityCap(render(), "vision").render()).props.onChange(false);
    expect(alerts(render())).toContain("Failed to update capacity adapter: Settings refused");
    expect(capacity(render()).props.capacityAdapter).toBe(before);

    card(render()).props.onDelete();
    await elements(render(), (element) => element.type === "ConfirmModal")[0].props.onConfirm();
    expect(alerts(render())).toContain("Failed to delete combo: Settings refused");
    expect(card(render())).toBeDefined();
  });

  it("applies strategy, capacity and delete writes once the API accepts them", async () => {
    const { render, fetch } = await combosPage(null);
    await card(render()).props.onSetStrategy({ fallbackStrategy: "round-robin" });
    expect(card(render()).props.strategy).toEqual({ fallbackStrategy: "round-robin" });
    expect(fetch).toHaveBeenLastCalledWith("/api/settings", expect.objectContaining({ method: "PATCH" }));

    await enableToggle(capacityCap(render(), "vision").render()).props.onChange(false);
    expect(capacity(render()).props.capacityAdapter.vision).toEqual({ enabled: false, roundRobin: false, models: [] });
    expect(JSON.parse(fetch.mock.lastCall[1].body)).toEqual({ capacityAdapter: capacity(render()).props.capacityAdapter });

    card(render()).props.onDelete();
    await elements(render(), (element) => element.type === "ConfirmModal")[0].props.onConfirm();
    expect(card(render())).toBeUndefined();
    expect(alerts(render())).toBe("");
  });
});

describe("proxy settings saves", () => {
  it.each(["/api/settings", "/api/proxy-pools?isActive=true"])("blocks proxy editing when %s fails to load", async (failedUrl) => {
    const fetch = vi.fn(async (url) => url === failedUrl
      ? Response.json({ error: "Read refused" }, { status: 403 })
      : Response.json(url.includes("proxy-pools") ? pools : settings));
    vi.stubGlobal("fetch", fetch);
    const component = dashboardComponent(proxyPath, imports);
    const props = { providerId: "local" };
    component.render(props);
    await vi.waitFor(() => expect(alerts(component.render(props))).toContain("Read refused"));
    expect(selects(component.render(props)).every((select) => select.props.disabled)).toBe(true);
    await selects(component.render(props))[0].props.onChange({ target: { value: "pool-b" } });
    expect(fetch.mock.calls.every(([, options]) => options.method === "GET")).toBe(true);
    expect(saved(component.render(props))).toHaveLength(0);
  });

  it.each(["read", "patch"])("retains the saved proxy value when the save %s fails and permits retry", async (failure) => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json(pools))
      .mockResolvedValueOnce(Response.json(settings))
      .mockResolvedValueOnce(failure === "read" ? new Response("Unavailable", { status: 503 }) : Response.json(settings));
    if (failure === "patch") fetch.mockResolvedValueOnce(Response.json({ error: "Write refused" }, { status: 403 }));
    fetch.mockResolvedValueOnce(Response.json(settings)).mockResolvedValueOnce(Response.json({}));
    vi.stubGlobal("fetch", fetch);
    const component = dashboardComponent(proxyPath, imports);
    const props = { providerId: "local" };
    component.render(props);
    await vi.waitFor(() => expect(selects(component.render(props))[0].props.value).toBe("pool-a"));
    await selects(component.render(props))[0].props.onChange({ target: { value: "pool-b" } });
    expect(alerts(component.render(props))).toContain(failure === "read" ? "503" : "Write refused");
    expect(selects(component.render(props))[0].props.value).toBe("pool-a");
    expect(selects(component.render(props))[0].props.disabled).toBe(false);
    expect(saved(component.render(props))).toHaveLength(0);
    if (failure === "read") expect(fetch.mock.calls.every(([, options]) => options.method === "GET")).toBe(true);
    await selects(component.render(props))[0].props.onChange({ target: { value: "pool-b" } });
    expect(selects(component.render(props))[0].props.value).toBe("pool-b");
    expect(saved(component.render(props))).toHaveLength(1);
    expect(JSON.parse(fetch.mock.calls.at(-1)[1].body)).toEqual({
      providerStrategies: { other: { proxyPoolId: "untouched" }, local: { proxyPoolId: "pool-b" } },
    });
  });
});

describe("reauthentication identity", () => {
  it.each([
    [{ connection: { id: "selected-account" } }, "selected-account"],
    [{ connectionId: "selected-account" }, "selected-account"],
    [{ success: true }, null],
    [undefined, null],
  ])("reads the saved connection id from %j", (result, id) => {
    expect(authenticatedConnectionId(result)).toBe(id);
  });

  it.each([{ connection: { id: "selected-account" } }, { connectionId: "selected-account" }])("confirms the account that received credentials %#", (result) => {
    expect(reauthOutcome("selected-account", result)).toBe("confirmed");
  });

  it.each([undefined, { success: true }, { connection: { id: "different-account" } }, { connectionId: "different-account" }])("keeps the selected account's error when sign-in does not confirm it %#", (result) => {
    expect(reauthOutcome("selected-account", result)).toBe("unconfirmed");
  });

  it.each([undefined, savedAccount])("does not warn when no account was selected for reauth %#", (result) => {
    expect(reauthOutcome(null, result)).toBe("none");
  });
});

describe("auth flows forward the saved connection", () => {
  it("forwards OAuthModal's poll-status connectionId to the parent", async () => {
    const pollResult = { status: "done", connectionId: "saved-account" };
    const fetch = vi.fn(async (url) => {
      if (url.includes("/authorize")) return Response.json({ authUrl: "https://auth.example.test/authorize", state: "state-1", codeVerifier: "verifier" });
      if (url.includes("/start-proxy")) return Response.json({ success: true, serverSide: true });
      if (url.includes("/poll-status")) return Response.json(pollResult);
      return Response.json({});
    });
    vi.stubGlobal("fetch", fetch);
    vi.stubGlobal("window", {
      location: { hostname: "localhost", origin: "http://localhost:20128", port: "20128", protocol: "http:" },
      open: vi.fn(() => ({})), addEventListener: vi.fn(), removeEventListener: vi.fn(),
    });
    vi.stubGlobal("BroadcastChannel", class { close() {} });
    const component = dashboardComponent("src/shared/components/OAuthModal.js", {
      ...componentImports,
      "@/shared/utils/oauthCallbackBinding.js": {
        PROXY_OAUTH_PROVIDERS: new Set(), openLoginPopup: () => ({}), openLoginTab: () => null,
        isOwnPopup: () => false, isTrustedCallbackOrigin: () => false, parsePastedCallback: () => ({}),
      },
    });
    const props = { isOpen: true, provider: "codex", providerInfo: { name: "Codex" }, onSuccess: vi.fn(), onClose: vi.fn() };
    await vi.waitFor(() => {
      component.render(props);
      expect(props.onSuccess).toHaveBeenCalled();
    }, { timeout: 4000, interval: 50 });
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining("/api/oauth/codex/poll-status?state=state-1"));
    expect(props.onSuccess).toHaveBeenCalledWith(pollResult);
    expect(reauthOutcome("saved-account", props.onSuccess.mock.calls[0][0])).toBe("confirmed");
  });

  it("forwards the connection the GitLab PAT route saved", async () => {
    createConnection.mockResolvedValue({ id: "selected-account", provider: "gitlab", email: "dev@example.test" });
    const fetch = vi.fn(async (url, init) => {
      if (url === "/api/oauth/gitlab/pat") return gitlabPat(new Request("http://localhost/api/oauth/gitlab/pat", init));
      if (url === "https://gitlab.com/api/v4/user") return Response.json({ email: "dev@example.test", username: "dev", name: "Dev" });
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetch);
    const component = dashboardComponent("src/shared/components/GitLabAuthModal.js", componentImports);
    const props = { isOpen: true, onSuccess: vi.fn(), onClose: vi.fn() };
    elements(component.render(props), (element) => element.type === "button" && textContent(element).includes("Personal Access Token"))[0].props.onClick();
    elements(component.render(props), (element) => element.type === "Input" && element.props.label === "Personal Access Token")[0].props.onChange({ target: { value: "glpat-test" } });
    await button(component.render(props), "Connect").props.onClick();
    expect(props.onSuccess).toHaveBeenCalledOnce();
    const [result] = props.onSuccess.mock.calls[0];
    expect(result).toMatchObject({ success: true, connection: { id: "selected-account" } });
    expect(reauthOutcome("selected-account", result)).toBe("confirmed");
  });

  const kiroWrapper = () => dashboardComponent("src/shared/components/KiroOAuthWrapper.js", imports);

  it.each(["import", "import-cli-proxy", "api-key"])("forwards Kiro's saved account after %s", (method) => {
    const wrapper = kiroWrapper();
    const props = { isOpen: true, onSuccess: vi.fn(), onClose: vi.fn() };
    wrapper.render(props).props.onMethodSelect(method, savedAccount);
    expect(props.onSuccess).toHaveBeenCalledWith(savedAccount);
  });

  it.each([
    ["social", { provider: "google" }, "KiroSocialOAuthModal"],
    ["builder-id", undefined, "OAuthModal"],
  ])("forwards the account saved by Kiro's %s sign-in and closes", (method, config, flowType) => {
    const wrapper = kiroWrapper();
    const props = { isOpen: true, onSuccess: vi.fn(), onClose: vi.fn() };
    wrapper.render(props).props.onMethodSelect(method, config);
    const flow = wrapper.render(props);
    expect(flow.type).toBe(flowType);
    flow.props.onSuccess(savedAccount);
    expect(props.onSuccess).toHaveBeenCalledWith(savedAccount);
    expect(props.onClose).toHaveBeenCalledOnce();
    expect(wrapper.render(props).type).toBe("KiroAuthModal");
  });

  it("forwards the account saved by KiroAuthModal's API-key form through the wrapper", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json(savedAccount));
    vi.stubGlobal("fetch", fetch);
    const props = { isOpen: true, onSuccess: vi.fn(), onClose: vi.fn() };
    const { onMethodSelect } = kiroWrapper().render(props).props;
    const modal = dashboardComponent("src/shared/components/KiroAuthModal.js", componentImports);
    const modalProps = { isOpen: true, onMethodSelect, onClose: vi.fn() };
    elements(modal.render(modalProps), (element) => element.type === "button" && textContent(element).includes("long-lived Kiro"))[0].props.onClick();
    elements(modal.render(modalProps), (element) => element.type === "Input" && element.props.placeholder === "Paste your Kiro API key...")[0].props.onChange({ target: { value: "kiro-key" } });
    await button(modal.render(modalProps), "Add API Key").props.onClick();
    expect(fetch).toHaveBeenCalledWith("/api/oauth/kiro/api-key", expect.objectContaining({ method: "POST" }));
    expect(props.onSuccess).toHaveBeenCalledWith(savedAccount);
  });
});
