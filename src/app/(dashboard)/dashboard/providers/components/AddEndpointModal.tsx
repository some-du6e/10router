"use client";

// "Add endpoint": paste a URL + key, we work out the rest with free requests.
// Matches the approved mockup (mockups/provider-setup/src/app.js, addModalBody):
// a live request list while checking, the slot machine for guessed models, one
// failure screen per cause, "It works" with the drawn check, "Stopped early"
// with a real "Check the rest", "Two for one" tiles, and a save that reports
// each step and offers Retry instead of closing.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent, ComponentType, KeyboardEvent, ReactNode } from "react";
import * as Shared from "@/shared/components";
import { buildRoutes, makePrefix, suggestName, normalizeUrl, cleanKey } from "@/lib/endpointDetect.js";
import { modelsNoteFor } from "@/app/api/providers/[id]/redetect/diff.js";
import type { Protocol, DetectStep, DetectQuirks, DetectResult, DetectProgress, ModelCheck, SiteInfo, StopReason } from "@/lib/endpointDetect.js";
import { RESERVED_PREFIXES, PREFIX_MAX_LENGTH, isReservedPrefix, prefixFormatProblem } from "@/shared/utils/reservedPrefixes.js";
import SlotMachine, { SlotFeed } from "./SlotMachine";
import { shrinkIcon } from "./shrinkIcon.js";
import EndpointAdvanced from "./EndpointAdvanced";
import { RedFlag, mimicLabel } from "./EndpointAdvancedParts";
import type { NodeQuirks } from "@/shared/utils/nodeQuirks.js";
import type { GatedDetectResult } from "@/lib/endpointImpersonate.js";
import {
  AppIcon, Badge, Btn, Chip, DrawnCheck, EASE, PROTOCOL_LABEL, SHORT, STOP_WHY, Spinner, StepList, TestedBox, TwoPaths,
  failCopy, hostOf, reduceMotion, splitPaths, stepNote, stepText,
} from "./AddEndpointParts";
import type { FailCopy, LiveStep } from "./AddEndpointParts";

// The shared components are untyped JS; re-type the props used here.
interface ModalProps { isOpen: boolean; title: string; onClose: () => void; size?: string; children?: ReactNode }
interface InputProps {
  label: ReactNode;
  value: string;
  onChange: (e: ChangeEvent<HTMLInputElement>) => void;
  onKeyDown?: (e: KeyboardEvent<HTMLInputElement>) => void;
  icon?: string;
  type?: string;
  placeholder?: string;
  hint?: ReactNode;
  error?: string;
  id?: string;
  autoFocus?: boolean;
  ignorePasswordManagers?: boolean;
}
const Modal = Shared.Modal as ComponentType<ModalProps>;
const Input = Shared.Input as ComponentType<InputProps>;

const NODE_TYPE: Record<Protocol, { nodeType: string; apiType?: string }> = {
  anthropic: { nodeType: "anthropic-compatible" },
  "openai-chat": { nodeType: "openai-compatible", apiType: "chat" },
  "openai-responses": { nodeType: "openai-compatible", apiType: "responses" },
};

const KEY_STATUS: Record<string, string> = {
  confirmed: "",
  likely: "",
  unknown: "Couldn't confirm the key. It will be checked on the first request.",
  none: "No key needed: it answered without one.",
};

// The detect route's result, plus `site` (fetched alongside).
type DetectResponse = GatedDetectResult & { site?: SiteInfo | null };

interface CreatedNode { id: string; [key: string]: unknown }
interface CreatedInfo { keyError: string | null; modelsFailed: number; modelsTotal: number }
interface SaveNodeResponse { node?: CreatedNode; error?: string; field?: string }

const DETECT_TIMEOUT_MS = 60_000;
const MODELS_PER_REQUEST = 1000; // MAX_BULK in src/app/api/models/custom/route.js
// Cheapest = first haiku/mini/nano/flash id, else the last one.
const cheapest = (models: string[]) => models.find((m) => /haiku|mini|nano|flash|lite/i.test(m)) || models[models.length - 1];

// Everything the endpoint stores (see nodeQuirks.ts); sent as-is on save.
type ModalQuirks = NodeQuirks & { stripBeta: boolean; maxCompletionTokens: boolean; droppedBetas: string[] };
// Detection reports apiKeyHeader as a boolean; stored quirks use "api-key".
const fromDetect = (q: DetectQuirks | undefined): Partial<ModalQuirks> => {
  const { apiKeyHeader, ...rest } = q || {};
  return { ...rest, ...(apiKeyHeader ? { apiKeyHeader: "api-key" as const } : {}) };
};
const DEFAULT_QUIRKS: ModalQuirks = { stripBeta: false, maxCompletionTokens: false, droppedBetas: [] };

type Phase = "idle" | "detecting" | "gated" | "found" | "failed";
interface Partial_ { checked: number; total: number; why: string; proto: Protocol; unchecked: string[]; running?: boolean; error?: string }
interface BetaCheck { model?: string; picking?: boolean; state?: "running" | "done" | "failed"; dropped?: string[]; error?: string }

// Read an NDJSON response line by line. Returns the { type: "result" } object.
async function readNdjson<T>(res: Response, onEvent: (e: DetectProgress) => void): Promise<T> {
  if (!res.body || !/ndjson/.test(res.headers.get("content-type") || "")) return res.json() as Promise<T>;
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let result: T | null = null;
  const line = (l: string) => {
    if (!l.trim()) return;
    const e = JSON.parse(l) as { type: string };
    if (e.type === "result") result = e as unknown as T;
    else onEvent(e as DetectProgress);
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n")) >= 0) { line(buf.slice(0, i)); buf = buf.slice(i + 1); }
  }
  line(buf);
  if (!result) throw new Error("No result");
  return result;
}

// Ease the dialog body from its old height to the new one on every change of
// what's shown, instead of jumping. Measures from the height on screen right
// now, even mid-animation, so a quick second change doesn't snap.
function useSmoothHeight(ref: React.RefObject<HTMLDivElement | null>, dep: unknown) {
  const last = useRef(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const to = el.getBoundingClientRect().height;
    const from = last.current;
    last.current = to;
    if (!from || Math.abs(to - from) < 1 || reduceMotion() || !el.animate) return;
    el.getAnimations().forEach((a) => a.cancel());
    el.style.overflow = "hidden";
    const a = el.animate([{ height: `${from}px` }, { height: `${to}px` }], { duration: 320, easing: EASE });
    a.onfinish = a.oncancel = () => { if (!el.getAnimations().length) el.style.overflow = ""; };
  });
  // Track resizes from things outside React's render (the slot machine's own list).
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return undefined;
    const ro = new ResizeObserver(() => { if (!el.getAnimations().length) last.current = el.getBoundingClientRect().height; });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, dep]);
}

interface AddEndpointModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCreated: (node: CreatedNode, info: CreatedInfo) => void;
  takenPrefixes?: string[];
}

function AddEndpointModal({ isOpen, onClose, onCreated, takenPrefixes = [] }: AddEndpointModalProps) {
  const [url, setUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [result, setResult] = useState<DetectResponse | null>(null);
  const [notice, setNotice] = useState("");
  const [steps, setSteps] = useState<LiveStep[]>([]);
  const [requests, setRequests] = useState(0);
  const [slots, setSlots] = useState(false);
  const [fail, setFail] = useState<FailCopy | null>(null);
  const [answered, setAnswered] = useState<string[]>([]);
  const [models, setModels] = useState<string[]>([]);
  const [byProtocol, setByProtocol] = useState<Partial<Record<Protocol, string[]>> | null>(null);
  const [checks, setChecks] = useState<Partial<Record<Protocol, ModelCheck>>>({});
  const [partial, setPartial] = useState<Partial_ | null>(null);
  const [name, setName] = useState("");
  const [prefix, setPrefix] = useState("");
  const [prefixEdited, setPrefixEdited] = useState(false);
  const [protoOverride, setProtoOverride] = useState<Protocol | "auto">("auto");
  const [quirks, setQuirks] = useState<ModalQuirks>(DEFAULT_QUIRKS);
  const [manualModels, setManualModels] = useState("");
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [pathOpen, setPathOpen] = useState<Protocol | null>(null);
  const [betaCheck, setBetaCheck] = useState<BetaCheck>({});
  const [saving, setSaving] = useState("");
  const [saveError, setSaveError] = useState("");
  const [savedNode, setSavedNode] = useState<CreatedNode | null>(null);
  const [keySaved, setKeySaved] = useState(false);
  const [prefixError, setPrefixError] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const [animate, setAnimate] = useState(0); // bumps when a result first appears
  const feed = useMemo(() => new SlotFeed(), []);
  const bodyRef = useRef<HTMLDivElement>(null);
  const urlRef = useRef<HTMLDivElement>(null);
  const keyRef = useRef<HTMLDivElement>(null);
  // The run in flight: a newer one (or a close/edit) aborts it, and a stale
  // response is dropped by id even if it already arrived.
  const runRef = useRef<{ id: number; controller: AbortController | null; timer: ReturnType<typeof setTimeout> | null }>({ id: 0, controller: null, timer: null });

  const taken = useMemo<string[]>(() => [...takenPrefixes, ...RESERVED_PREFIXES], [takenPrefixes]);
  const prefixIssue = useCallback((p: string): string => {
    const v = String(p || "").trim().toLowerCase();
    if (!v) return "Required.";
    const format = prefixFormatProblem(v);
    if (format) return format;
    if (isReservedPrefix(v)) return `Taken by a built-in provider, so ${v}/… would go there.`;
    if (takenPrefixes.some((t) => String(t).toLowerCase() === v) && !(savedNode && String(savedNode.prefix || "") === v)) return "Taken by another of your endpoints.";
    return "";
  }, [takenPrefixes, savedNode]);

  const stopRun = () => {
    const cur = runRef.current;
    cur.id += 1;
    cur.controller?.abort();
    clearTimeout(cur.timer ?? undefined);
    cur.controller = null; cur.timer = null;
    feed.reset();
  };
  const startRun = () => {
    stopRun();
    const cur = runRef.current;
    const controller = new AbortController();
    cur.controller = controller;
    const id = cur.id;
    return { id, controller, live: () => runRef.current.id === id };
  };

  const reset = () => {
    stopRun();
    setUrl(""); setApiKey(""); setPhase("idle"); setResult(null); setNotice(""); setSteps([]); setRequests(0); setSlots(false);
    setFail(null); setAnswered([]); setModels([]); setByProtocol(null); setChecks({}); setPartial(null);
    setName(""); setPrefix(""); setPrefixEdited(false); setProtoOverride("auto"); setQuirks(DEFAULT_QUIRKS); setManualModels("");
    setDetailsOpen(false); setPathOpen(null); setBetaCheck({}); setSaving(""); setSaveError(""); setSavedNode(null); setKeySaved(false); setPrefixError("");
  };
  const close = () => { reset(); onClose(); };

  useEffect(() => { if (!isOpen) stopRun(); }, [isOpen]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => stopRun(), []); // eslint-disable-line react-hooks/exhaustive-deps

  // Autofocus the URL when the dialog opens.
  useEffect(() => {
    if (!isOpen) return undefined;
    const t = setTimeout(() => urlRef.current?.querySelector("input")?.focus(), 30);
    return () => clearTimeout(t);
  }, [isOpen]);

  // Tick for "3s…" on a request that's hanging.
  const busy = phase === "detecting" || !!partial?.running || betaCheck.state === "running";
  useEffect(() => {
    if (!busy) return undefined;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [busy]);

  // ---- progress events -> live list ----
  const onProgress = (e: DetectProgress) => {
    if ("sent" in e && typeof e.sent === "number") setRequests((r) => Math.max(r, e.sent));
    if (e.type === "request") {
      setRequests((r) => r + 1); // counted when sent, like the mockup; responses only catch the count up
      // Control probes (a made-up path) back up a finding; they stay under raw responses.
      if (/^Control \(made-up path/.test(e.label)) return;
      setSteps((s) => [...s, { n: e.n, text: stepText(e.label, e.method, e.path), state: "run", note: "", startedAt: Date.now() }]);
      return;
    }
    if (e.type === "response") {
      setSteps((list) => list.map((s) => {
        if (s.n !== e.n) return s;
        const label = list.find((x) => x.n === e.n)?.text || "";
        const raw = /^POST .*made-up model id/.test(label) ? "Check model (made-up id)" : /\(control:/.test(label) ? "Control" : /Bad-key/.test(label) ? "Bad-key check" : label;
        const nt = stepNote(raw, e.status, e.kind, e.hint, e.retrying);
        if (e.retrying) return { ...s, note: nt.note, warn: true };
        return { ...s, state: "done", status: e.status, kind: e.kind, hint: e.hint, ...nt };
      }));
      return;
    }
    if (e.type === "models-start") { setSlots(true); feed.push(e); return; }
    if (e.type === "models-done") {
      feed.push(e);
      const stopNote: Partial<Record<StopReason, string>> = { rate: "429 · gave up after retries", auth: "401 · key no longer accepted", denied: "the key can't use these", failing: "kept failing", deadline: "out of time" };
      setSteps((s) => [...s, {
        n: -s.length - 1, startedAt: Date.now(), state: "done",
        text: e.stopped ? `Model checks ${e.checked} of ${e.total}` : `Model checks on ${e.path}`,
        ok: !e.stopped, warn: !!e.stopped && e.stopped !== "aborted",
        note: e.stopped ? stopNote[e.stopped] || e.stopped : `${e.checked} asked · ${e.found} served`,
      }]);
      return;
    }
    feed.push(e);
  };

  const fillName = (r: DetectResponse | null, fallbackUrl: string) => {
    const base = r?.baseUrl || normalizeUrl(fallbackUrl);
    const guess = r?.site?.name || r?.suggestedName || (base ? suggestName(base) : "");
    setName(guess);
    if (!prefixEdited) setPrefix(makePrefix(guess, taken));
  };

  // ---- detect ----
  const detect = async () => {
    if (!url.trim()) return;
    const run = startRun();
    let timedOut = false;
    runRef.current.timer = setTimeout(() => { timedOut = true; run.controller.abort(); }, DETECT_TIMEOUT_MS);
    setPhase("detecting"); setSteps([]); setRequests(0); setNotice(""); setFail(null); setAnswered([]); setResult(null);
    setPartial(null); setSaveError(""); setSlots(false); setDetailsOpen(false); setPathOpen(null); setBetaCheck({}); setPrefixError("");
    // A new run may find another URL or API, so an endpoint saved before it is not this one.
    setSavedNode(null); setKeySaved(false);
    let data: DetectResponse;
    try {
      const res = await fetch("/api/provider-nodes/detect", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/x-ndjson" },
        body: JSON.stringify({ url, apiKey }),
        signal: run.controller.signal,
      });
      data = await readNdjson<DetectResponse>(res, (e) => { if (run.live()) onProgress(e); });
      if (!run.live()) return;
      await feed.settled(); // let the reel catch up
      if (!run.live()) return;
    } catch {
      if (!run.live()) return; // cancelled, closed or superseded
      data = { ok: false, failure: timedOut ? "timeout" : undefined, error: timedOut ? "Testing took over a minute, so we stopped. The endpoint may be slow or rate limiting; try again, or save it and add models by hand." : "Network error: couldn't reach 10router.", steps: [] };
    } finally {
      if (run.live()) { clearTimeout(runRef.current.timer ?? undefined); runRef.current.controller = null; runRef.current.timer = null; }
    }
    setResult(data); setSlots(false); feed.reset(); setAnimate((a) => a + 1);
    setRequests((r) => Math.max(r, data.steps?.length || 0));
    fillName(data, url);

    // A key that stopped working part-way (worked, then 401 on model checks).
    // The mockup fails here even when some models answered first (it lists them).
    const authStop = data.ok && data.stopReason === "auth" && (!!data.authRejected || !!data.models?.length);
    if (!data.ok || authStop) {
      const checkedSoFar = Object.values(data.checks || {}).reduce((a, c) => a + (c?.checked || 0), 0);
      if (authStop) setAnswered([...new Set(Object.values(data.byProtocol || {}).flat().filter(Boolean) as string[])]);
      setFail(failCopy({ failure: data.failure, error: data.error, steps: liveSteps(), netCount: (data.steps || []).filter((x) => !x.status && !/^Control/.test(x.label)).length, url, revoked: authStop ? { checked: checkedSoFar } : null }));
      setPhase("failed");
      return;
    }
    setModels(primaryFirst(data.models || [], data.routes));
    setByProtocol(data.byProtocol || null);
    setChecks(data.checks || {});
    setQuirks({ ...DEFAULT_QUIRKS, ...fromDetect(data.quirks) });
    setProtoOverride("auto");
    // Stopped early: the first API (in check order) that has ids never asked.
    const p = (Object.entries(data.checks || {}) as [Protocol, ModelCheck][]).find(([, c]) => c.unchecked.length && c.stopped && c.stopped !== "aborted");
    if (p) setPartial({ proto: p[0], checked: p[1].checked, total: p[1].total, unchecked: p[1].unchecked, why: STOP_WHY[p[1].stopped as StopReason] || "" });
    // Only got in as a known client: ask before pretending to be it.
    if (data.gate) { setPhase("gated"); return; }
    setPhase("found");
    focusName();
  };
  const focusName = () => setTimeout(() => bodyRef.current?.querySelector<HTMLInputElement>("#ep-name")?.focus({ preventScroll: true }), 30);
  const acceptMimic = () => {
    const gate = result?.gate;
    if (!gate) return;
    setQuirks((q) => ({ ...q, mimic: gate.client }));
    setPhase("found"); setAnimate((a) => a + 1);
    focusName();
  };
  // Latest steps for code running after awaits (state in the closure is stale).
  const stepsRef = useRef<LiveStep[]>([]);
  useEffect(() => { stepsRef.current = steps; }, [steps]);
  const liveSteps = () => stepsRef.current;

  const cancelDetect = () => {
    const n = requests;
    stopRun();
    setPhase("idle"); setSlots(false);
    setNotice(`Cancelled after ${n} request${n === 1 ? "" : "s"}. Nothing was saved.`);
  };

  const editKey = () => {
    stopRun();
    setPhase("idle"); setApiKey(""); setFail(null); setKeySaved(false);
    setNotice("Paste a working key, then connect again.");
    setTimeout(() => keyRef.current?.querySelector("input")?.focus(), 30);
  };

  const onUrlOrKeyEdit = () => {
    if (phase === "detecting" || phase === "idle") return;
    stopRun(); setPhase("idle"); setResult(null); setFail(null); setPartial(null); setSaveError("");
    setSavedNode(null); setKeySaved(false);
  };

  // ---- check the rest ----
  const checkRest = async () => {
    const pt = partial;
    if (!pt || !result?.baseUrl) return;
    const run = startRun();
    setPartial({ ...pt, running: true, error: undefined });
    try {
      const res = await fetch("/api/provider-nodes/detect/models", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/x-ndjson" },
        body: JSON.stringify({ baseUrl: result.baseUrl, apiKey, protocol: pt.proto, ids: pt.unchecked, quirks: { maxCompletionTokens: quirks.maxCompletionTokens, apiKeyHeader: !!quirks.apiKeyHeader } }),
        signal: run.controller.signal,
      });
      const data = await readNdjson<{ ok: boolean; error?: string; models: string[]; check: ModelCheck; steps: DetectStep[] }>(res, () => {});
      if (!run.live()) return;
      setRequests((r) => r + (data.steps?.length || 0));
      if (!data.ok) { setPartial({ ...pt, running: false, error: data.error }); return; }
      const more = data.models || [];
      const nextBy = { ...(byProtocol || {}), [pt.proto]: [...new Set([...(byProtocol?.[pt.proto] || []), ...more])] };
      const built = buildRoutes(nextBy);
      setByProtocol(nextBy);
      setModels(primaryFirst(built.models, built.routes));
      setResult((r) => r ? { ...r, routes: built.routes as Record<string, Protocol>, protocol: (built.primary as Protocol) || r.protocol, steps: [...r.steps, ...(data.steps || [])] } : r);
      const prev = checks[pt.proto];
      const merged: ModelCheck = { total: pt.total, checked: pt.checked + data.check.checked, found: (prev?.found || 0) + more.length, unchecked: data.check.unchecked, stopped: data.check.stopped };
      setChecks((c) => ({ ...c, [pt.proto]: merged }));
      setSteps((s) => [...s, { n: -s.length - 1, startedAt: Date.now(), state: "done", ok: !data.check.stopped, warn: !!data.check.stopped, text: `Model checks ${pt.checked + 1}-${pt.checked + data.check.checked}, 1 at a time`, note: `${data.check.checked} asked · ${more.length} served` }]);
      if (data.check.unchecked.length && data.check.stopped) setPartial({ ...pt, running: false, checked: merged.checked, unchecked: data.check.unchecked, why: STOP_WHY[data.check.stopped] });
      else { setPartial(null); setAnimate((a) => a + 1); }
    } catch {
      if (run.live()) setPartial({ ...pt, running: false, error: "Network error. Try again." });
    }
  };

  // ---- test message (beta flags) ----
  const effProto: Protocol = protoOverride !== "auto" ? protoOverride : (result?.protocol || "openai-chat");
  const msgModels = useMemo(() => {
    const anth = byProtocol?.anthropic;
    return anth?.length ? anth : effProto === "anthropic" ? models : [];
  }, [byProtocol, models, effProto]);
  const testModel = betaCheck.model || cheapest(msgModels.filter((m) => /claude/i.test(m)).length ? msgModels.filter((m) => /claude/i.test(m)) : msgModels);
  const runBetaCheck = async () => {
    if (!result?.baseUrl || !testModel) return;
    const model = testModel;
    setBetaCheck({ model, state: "running" });
    try {
      const res = await fetch("/api/provider-nodes/detect/test-message", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ baseUrl: result.baseUrl, apiKey, protocol: "anthropic", model, quirks }),
      });
      const d: { ok: boolean; dropped?: string[]; error?: string } = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
      const dropped = d.dropped || [];
      if (dropped.length) setQuirks((q) => ({ ...q, droppedBetas: [...new Set([...q.droppedBetas, ...dropped])] }));
      setRequests((r) => r + 1 + (dropped.length ? 1 : 0));
      setBetaCheck({ model, state: d.ok ? "done" : "failed", dropped, error: d.error });
    } catch {
      setBetaCheck({ model, state: "failed", error: "Network error" });
    }
  };

  const onNameChange = (v: string) => {
    setName(v);
    if (!prefixEdited) { const p = makePrefix(v, taken); setPrefix(p); setPrefixError(""); }
  };

  // ---- save ----
  const save = async (unverified = false) => {
    if (saving) return;
    const chosen: Protocol = unverified ? (protoOverride !== "auto" ? protoOverride : "openai-chat") : effProto;
    const found = phase === "found" && !!result?.ok;
    const verified = !unverified && found && (result!.protocols?.length ? result!.protocols : [result!.protocol]).includes(chosen);
    const list: string[] = !found ? manualModels.split(/[\s,]+/).map((m) => m.trim()).filter(Boolean)
      : chosen !== result!.protocol && byProtocol ? byProtocol[chosen] || []
      : models.length ? models : manualModels.split(/[\s,]+/).map((m) => m.trim()).filter(Boolean);
    const nm = name.trim() || (result?.suggestedName ?? "Endpoint");
    const pf = (unverified && prefixIssue(prefix)) ? makePrefix(nm, taken) : prefix.trim();
    const issue = prefixIssue(pf);
    if (issue) { setPrefixError(issue); return; }
    setSaveError(""); setPrefixError("");
    const proto = NODE_TYPE[chosen];
    // Step 1: the node. The server returns the existing node for the same
    // endpoint, so a retry never adds a second one.
    let node = savedNode;
    if (!node) {
      setSaving("Saving endpoint…");
      try {
        const res = await fetch("/api/provider-nodes", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: nm, prefix: pf, type: proto.nodeType, ...(proto.apiType ? { apiType: proto.apiType } : {}),
            baseUrl: result?.baseUrl || normalizeUrl(url) || url,
            quirks: { ...quirks, ...(found && result?.routes && chosen === result.protocol ? { modelRoutes: result.routes } : {}) },
            verified,
            modelsNote: (found && chosen === result!.protocol && modelsNoteFor(result!)) || undefined,
          }),
        });
        const d: SaveNodeResponse = await res.json().catch(() => ({}));
        if (!res.ok || !d.node) {
          setSaving("");
          if (d.field === "prefix") setPrefixError(d.error ?? "");
          else setSaveError(`${d.error || `Couldn't save the endpoint (HTTP ${res.status}).`} Nothing was saved.`);
          return;
        }
        node = d.node;
        setSavedNode(node);
        // The site icon copied during detection (a data: URL). Best effort: the
        // icon route validates it, and a failure just leaves the letter tile.
        const icon = result?.site?.icon ? await shrinkIcon(result.site.icon) : null;
        if (icon) {
          const created = node;
          await fetch(`/api/providers/${created.id}/redetect/icon`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ icon, siteIcon: icon }) })
            .then(async (r) => { const j: { node?: CreatedNode } = await r.json().catch(() => ({})); if (r.ok && j.node) { node = j.node; setSavedNode(j.node); } })
            .catch(() => {});
        }
      } catch {
        setSaving(""); setSaveError("Network error. Nothing was saved; try again.");
        return;
      }
    }
    // Step 2: the key.
    if (apiKey.trim() && !keySaved) {
      setSaving("Saving key…");
      let err = "";
      try {
        const res = await fetch("/api/providers", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ provider: node.id, apiKey: cleanKey(apiKey), defaultModel: list[0] || null, testStatus: verified ? "active" : "unknown" }),
        });
        if (!res.ok) { const d: { error?: string } = await res.json().catch(() => ({})); err = `HTTP ${res.status}${d.error ? `, ${d.error}` : ""}`; }
      } catch { err = "network error"; }
      if (err) {
        setSaving("");
        setSaveError(`The endpoint was created, but saving the key failed (${err}). Retry finishes the same endpoint, it won't add a second one.`);
        return;
      }
      setKeySaved(true);
    }
    // Step 3: the models.
    let modelsFailed = 0;
    if (list.length) {
      setSaving(`Adding ${list.length} model${list.length === 1 ? "" : "s"}…`);
      for (let i = 0; i < list.length; i += MODELS_PER_REQUEST) {
        const chunk = list.slice(i, i + MODELS_PER_REQUEST);
        try {
          const res = await fetch("/api/models/custom", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ providerAlias: node.id, type: "llm", models: chunk }) });
          const d: { failed?: unknown } = await res.json().catch(() => ({}));
          modelsFailed += Array.isArray(d.failed) ? d.failed.length : res.ok ? 0 : chunk.length;
        } catch { modelsFailed += chunk.length; }
      }
      if (modelsFailed === list.length) {
        setSaving("");
        setSaveError(`The endpoint and key were saved, but adding the ${list.length} models failed. Retry adds them to the same endpoint.`);
        return;
      }
    }
    if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("customModelChanged"));
    onCreated(node, { keyError: null, modelsFailed, modelsTotal: list.length });
    reset();
  };

  // ---- derived ----
  const ok = phase === "found" && result?.ok ? result : null;
  const protocols = ok?.protocols || [];
  const split = ok ? splitPaths(models, ok.protocol!, ok.routes, byProtocol) : null;
  const site = result?.site || null;
  const keyStatus = ok ? (!apiKey.trim() ? "none" : ok.keyConfirmed || "unknown") : "unknown";
  const guessChecked = Object.values(checks).reduce((a, c) => a + (c?.checked || 0), 0);
  const count = models.length;
  const hasAnthropic = protocols.includes("anthropic") || effProto === "anthropic";
  const notUsed = (result?.steps || []).filter((s) => / \(empty\)$/.test(s.label) && s.status && !(s.status >= 400 && s.status < 500 && s.status !== 404 && s.status !== 405) && !(protocols.some((p) => s.url.endsWith(p === "anthropic" ? "/messages" : p === "openai-chat" ? "/chat/completions" : "/responses"))))
    .map((s) => `${s.label.replace(/^POST /, "").replace(/ \(empty\)$/, "")} (${s.status})`)
    .filter((v, i, a) => a.indexOf(v) === i).slice(0, 3);
  const clash = phase === "found" ? prefixIssue(prefix) : "";
  const said = phase === "detecting" ? (steps.length ? `${steps[steps.length - 1].text}${steps[steps.length - 1].state === "run" ? "…" : `: ${steps[steps.length - 1].note}`}` : "Testing")
    : phase === "found" ? (partial ? "Works, model check stopped early" : "It works") : phase === "gated" ? "Only works when pretending to be a specific client" : phase === "failed" ? fail?.title || "Couldn't connect" : "";

  useSmoothHeight(bodyRef, isOpen);

  const enterKey = (e: KeyboardEvent<HTMLInputElement>) => { if (e.key === "Enter" && phase === "idle" && url.trim()) { e.preventDefault(); detect(); } };

  const head = (
    <>
      <div ref={urlRef}>
        <Input id="ep-url" label="Endpoint URL" icon="link" value={url} placeholder="https://api.example.com/v1" onKeyDown={enterKey}
          onChange={(e) => { setUrl(e.target.value); onUrlOrKeyEdit(); }}
          hint="Any form works: base URL, /v1, /messages, /chat/completions." ignorePasswordManagers />
      </div>
      <div ref={keyRef}>
        <Input id="ep-key" label="API key" icon="key" type="password" value={apiKey} onKeyDown={enterKey}
          onChange={(e) => { setApiKey(e.target.value); onUrlOrKeyEdit(); }}
          hint="Optional for local servers that don't need one." ignorePasswordManagers />
      </div>
    </>
  );

  const live = <p className="sr-only" role="status" aria-live="polite">{said}</p>;

  let body: ReactNode;
  if (phase === "idle") {
    body = (
      <>
        {notice && <p className="ep-in rounded-[10px] bg-surface-2 px-3 py-2 text-xs text-text-muted">{notice}</p>}
        <Btn icon="bolt" full disabled={!url.trim()} onClick={detect}>Connect</Btn>
        <p className="text-center text-xs text-text-muted">We work out the API type, models and quirks with free requests only. Nothing gets generated.</p>
      </>
    );
  } else if (phase === "detecting") {
    body = (
      <>
        {live}
        <StepList steps={steps} now={now} />
        {slots && <SlotMachine feed={feed} />}
        <div className="flex items-center gap-2">
          <span className="flex flex-1 items-center gap-2 text-xs text-text-muted"><Spinner />Testing… {requests} request{requests === 1 ? "" : "s"} so far</span>
          <Btn icon="close" variant="secondary" size="sm" onClick={cancelDetect}>Cancel</Btn>
        </div>
      </>
    );
  } else if (phase === "failed" && fail) {
    const keyProblem = fail.kind === "key" || fail.kind === "revoked";
    const canSave = fail.kind === "down" || fail.kind === "unreachable" || fail.kind === "other";
    body = (
      <>
        {live}
        <div key={animate} role="alert" className="ep-in flex items-start gap-2 rounded-[10px] border border-red-500/20 bg-red-500/5 p-3 text-sm">
          <span className="material-symbols-outlined text-[18px] text-red-600 dark:text-red-400" aria-hidden="true">{fail.icon}</span>
          <div className="flex min-w-0 flex-col gap-1">
            <span className="font-semibold text-red-600 dark:text-red-400">{fail.title}</span>
            <span className="text-xs text-text-muted">{fail.body}</span>
          </div>
        </div>
        {answered.length > 0 && (
          <div className="flex flex-col gap-1.5 rounded-[10px] bg-surface-2 p-3 text-xs">
            <span className="text-text-muted">Answered before the key stopped working ({answered.length}):</span>
            <div className="flex flex-wrap gap-1.5">{answered.map((m) => <Chip key={m}>{m}</Chip>)}</div>
          </div>
        )}
        <TestedBox steps={steps} raw={result?.steps || []} count={requests} open now={now} />
        {canSave && (
          <div className="grid grid-cols-[1fr_120px] gap-3">
            <Input id="ep-name" label="Name" value={name} onChange={(e) => onNameChange(e.target.value)} />
            <Input id="ep-prefix" label="Prefix" value={prefix} onChange={(e) => { const v = e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, PREFIX_MAX_LENGTH); setPrefix(v); setPrefixEdited(v !== ""); setPrefixError(""); }} error={prefixError || undefined} />
          </div>
        )}
        {saveError && <SaveErrorBox text={saveError} />}
        <div className="flex flex-col gap-2 sm:flex-row">
          <Btn icon={keyProblem ? "key" : "refresh"} variant="secondary" full onClick={keyProblem ? editKey : detect}>{keyProblem ? "Change key" : "Try again"}</Btn>
          {canSave && <Btn full disabled={!!saving} busy={!!saving} onClick={() => save(true)}>{saving || (saveError ? "Retry" : "Save anyway, unverified")}</Btn>}
        </div>
      </>
    );
  } else if (phase === "gated" && result?.gate) {
    const g = result.gate;
    body = (
      <>
        {live}
        <StepList steps={steps} now={now} />
        <div key={animate} className="ep-in flex flex-col gap-3 rounded-[10px] border border-border-subtle p-4">
          <div className="flex items-center gap-2">
            <span className="material-symbols-outlined text-[20px] text-yellow-600 dark:text-yellow-400" aria-hidden="true">gpp_maybe</span>
            <span className="text-sm font-semibold text-text-main">Only works if we pretend to be {g.label}</span>
          </div>
          <p className="text-xs text-text-muted">It turns away every client it doesn&apos;t recognise, before it even looks at your key. Sending {g.label}&apos;s headers got us in{g.alsoWorks ? ` (${g.alsoWorks} works too)` : ""}.</p>
          <RedFlag who={g.label} />
        </div>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Btn variant="secondary" full onClick={close}>Cancel</Btn>
          <Btn icon="theater_comedy" full onClick={acceptMimic}>Connect as {g.label}</Btn>
        </div>
      </>
    );
  } else if (ok) {
    const hasDetails = !!split || hasAnthropic;
    body = (
      <>
        {live}
        <div key={animate} className={`ep-in flex flex-col gap-3 rounded-[10px] border p-4 ${partial ? "border-yellow-500/30 bg-yellow-500/5" : "border-green-500/20 bg-green-500/5"}`}>
          <div className="flex items-center gap-2">
            <DrawnCheck />
            <span className="text-sm font-semibold text-text-main">It works</span>
            <span className="ml-auto"><Badge variant="success">{split ? split.used.map((p) => SHORT[p]).join(" + ") : PROTOCOL_LABEL[effProto]}</Badge></span>
          </div>
          {KEY_STATUS[keyStatus] && <p className="-mt-1 text-xs text-text-muted">{KEY_STATUS[keyStatus]}</p>}
          {partial && <PartialBox pt={partial} found={checks[partial.proto]?.found ?? 0} onCheck={checkRest} />}
          {count > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {models.slice(0, 6).map((m) => <span key={m} className="rounded-full border border-border-subtle bg-surface px-2 py-0.5 font-mono text-[11px] text-text-muted">{m}</span>)}
              {count > 6 && <span className="rounded-full bg-surface px-2 py-0.5 text-[11px] font-semibold text-text-muted">+{count - 6}</span>}
            </div>
          ) : (
            <p className="text-xs text-text-muted">No model list found. Add model IDs below.</p>
          )}
          {(ok.modelsSource === "guessed" || ok.modelsSource === "catalog") && !partial && !split && (
            <p className="text-[11px] text-text-subtle">No model list here, so we checked known models one by one: {guessChecked} checked, {count} found, {guessChecked - count} not served. Add any we missed on the endpoint page.</p>
          )}
          {split && split.used.includes("anthropic") && (
            <p className="text-xs text-text-muted">Claude models go to Anthropic Messages, everything else to {split.used.filter((p) => p !== "anthropic").map((p) => PROTOCOL_LABEL[p].replace("OpenAI · ", "")).join(" and ")}. Beta flags {name || "it"} rejects get dropped automatically.</p>
          )}
          {hasDetails && (
            <>
              <button type="button" onClick={() => setDetailsOpen((o) => !o)} aria-expanded={detailsOpen} className="-mt-1 inline-flex w-fit items-center gap-0.5 text-xs font-medium text-text-muted hover:text-text-main">
                <span className={`material-symbols-outlined text-[16px] transition-transform duration-200 ${detailsOpen ? "rotate-90" : ""}`} aria-hidden="true">chevron_right</span>{detailsOpen ? "Hide details" : "Details"}
              </button>
              {detailsOpen && (
                <div className="ep-in flex flex-col gap-3">
                  {split && <TwoPaths split={split} open={pathOpen} onOpen={setPathOpen} checks={checks} notUsed={notUsed} />}
                  {hasAnthropic && msgModels.length > 0 && (
                    <BetaBox bc={betaCheck} model={testModel} models={msgModels} name={name || hostOf(url)} dropped={quirks.droppedBetas}
                      onTest={runBetaCheck} onPick={() => setBetaCheck((b) => ({ ...b, picking: !b.picking }))} onModel={(m) => setBetaCheck((b) => ({ ...b, model: m }))}
                      onUndrop={(f) => setQuirks((q) => ({ ...q, droppedBetas: q.droppedBetas.filter((x) => x !== f) }))} />
                  )}
                </div>
              )}
            </>
          )}
          {quirks.mimic && quirks.mimic !== "none" && (
            <span className="inline-flex items-center gap-1 text-xs text-yellow-700 dark:text-yellow-400"><span className="material-symbols-outlined text-[14px]" aria-hidden="true">theater_comedy</span>Pretending to be {mimicLabel(quirks.mimic)}. You can turn this off under Advanced.</span>
          )}
        </div>
        <TestedBox steps={steps} raw={result?.steps || []} count={requests} open={false} now={now} />
        <div className="flex items-center gap-2.5 rounded-[10px] bg-surface-2 px-3 py-2 text-xs text-text-muted">
          <AppIcon icon={site?.icon} name={name} size={24} />
          <span className="min-w-0 truncate">
            Name{site?.icon ? ", prefix and icon" : " and prefix"} from <span className="font-medium text-text-main">{site?.host || siteLabel(result?.baseUrl || url)}</span>{site?.icon ? "" : " (no site icon, so a letter)"}
          </span>
        </div>
        <div className="grid grid-cols-[1fr_120px] gap-3">
          <Input id="ep-name" label="Name" value={name} onChange={(e) => onNameChange(e.target.value)} />
          <Input id="ep-prefix" label="Prefix" value={prefix} onChange={(e) => { const v = e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, PREFIX_MAX_LENGTH); setPrefix(v); setPrefixEdited(v !== ""); setPrefixError(""); }} />
        </div>
        <p className="-mt-2 text-xs text-text-muted">
          {prefixError || clash
            ? <span className="text-red-600 dark:text-red-400">{prefixError || clash} Pick another.</span>
            : <>Models will be <code className="font-mono">{prefix}/{models[0] || "model-id"}</code></>}
        </p>
        {count === 0 && (
          <Input label="Model IDs" value={manualModels} onChange={(e) => setManualModels(e.target.value)} placeholder="model-a, model-b" hint="Comma or space separated." />
        )}
        <EndpointAdvanced quirks={quirks} onChange={(p) => setQuirks((q) => ({ ...q, ...p }))} protoOverride={protoOverride} onProtoChange={setProtoOverride}
          detected={ok.protocol ?? null} protocols={protocols} routed={!!split} maxTokensRejected={mctRejected(quirks, result?.steps || [])}
          baseUrl={result?.baseUrl || url} model={models[0]} apiKey={apiKey} />
        {saveError && <SaveErrorBox text={saveError} />}
        <Btn full icon={saving ? undefined : saveError ? "refresh" : "add"} busy={!!saving} disabled={!!saving || !!clash || !!prefixError} onClick={() => save(false)}>
          {saving || (saveError ? "Retry" : "Add endpoint")}
        </Btn>
      </>
    );
  }

  return (
    <Modal isOpen={isOpen} title="Add endpoint" onClose={close} size="lg">
      <div ref={bodyRef}>
        <div className="flex flex-col gap-4">
          {head}
          {body}
        </div>
      </div>
    </Modal>
  );
}

// The mockup lists the primary API's models first, then the routed ones.
const primaryFirst = (ids: string[], routes?: Record<string, unknown>) =>
  routes ? [...ids.filter((m) => !routes[m]), ...ids.filter((m) => routes[m])] : ids;

const siteLabel = (u: string) => {
  try { const h = new URL(normalizeUrl(u) || u).hostname; return /^\d+\.\d+\.\d+\.\d+$/.test(h) ? h : h.split(".").slice(-2).join("."); } catch { return u; }
};

function SaveErrorBox({ text }: { text: string }) {
  return (
    <div role="alert" className="ep-in flex items-start gap-2 rounded-[10px] border border-red-500/20 bg-red-500/5 p-3 text-xs text-red-600 dark:text-red-400">
      <span className="material-symbols-outlined text-[16px]" aria-hidden="true">error</span><span>{text}</span>
    </div>
  );
}

// Model check stopped early: how far it got, why, and the rest on offer.
function PartialBox({ pt, found, onCheck }: { pt: Partial_; found: number; onCheck: () => void }) {
  const rest = pt.total - pt.checked;
  if (pt.running) return <div className="flex items-center gap-2 rounded-[8px] bg-surface px-3 py-2 text-xs text-text-muted"><Spinner />Checking the other {pt.unchecked.length}, 1 at a time…</div>;
  return (
    <div className="ep-in flex flex-col gap-2 rounded-[8px] border border-yellow-500/30 bg-surface px-3 py-2.5 text-xs">
      <div className="flex items-start gap-2">
        <span className="material-symbols-outlined text-[16px] text-yellow-600 dark:text-yellow-400" aria-hidden="true">hourglass_top</span>
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="font-medium text-text-main">Stopped early: {pt.checked} of {pt.total} checked</span>
          <span className="text-text-muted">{pt.why} {pt.checked} checked = {found} found + {pt.checked - found} not served. The other {rest} weren&apos;t asked about, so models may be missing. You can add it now and check later from the endpoint page.</span>
          {pt.error && <span className="text-red-600 dark:text-red-400">{pt.error}</span>}
        </div>
      </div>
      <div className="pl-6"><Btn icon="refresh" variant="secondary" size="sm" onClick={onCheck}>Check the rest ({pt.unchecked.length})</Btn></div>
    </div>
  );
}

interface BetaBoxProps { bc: BetaCheck; model: string; models: string[]; name: string; dropped: string[]; onTest: () => void; onPick: () => void; onModel: (m: string) => void; onUndrop: (f: string) => void }
// Beta flags can only be tested with a real (1-token) request, so this asks:
// test now, or with a model you pick. Never automatic.
function BetaBox({ bc, model, models, name, dropped, onTest, onPick, onModel, onUndrop }: BetaBoxProps) {
  const code = (t: string) => <code key={t} className="font-mono">{t}</code>;
  const droppedChips = dropped.length > 0 && (
    <div className="flex flex-col gap-1.5 pl-6">
      <p className="text-text-muted">Dropped because the endpoint rejected them:</p>
      <div className="flex flex-wrap gap-1.5">
        {dropped.map((b) => (
          <span key={b} className="inline-flex items-center gap-1 rounded-full border border-border-subtle bg-surface px-2 py-0.5 font-mono text-[11px] text-text-muted">
            {b}<button type="button" onClick={() => onUndrop(b)} aria-label={`Send ${b} again`} className="material-symbols-outlined text-[13px] hover:text-text-main">close</button>
          </span>
        ))}
      </div>
    </div>
  );
  if (bc.state === "running") {
    return <div className="ep-in flex items-center gap-2 rounded-[8px] bg-surface px-3 py-2 text-xs text-text-muted"><Spinner className="" />Sending &quot;hi&quot; to {code(model)} with Claude Code&apos;s beta flags…</div>;
  }
  if (bc.state === "done") {
    const d = bc.dropped || [];
    return (
      <div className="ep-in flex flex-col gap-2 rounded-[8px] bg-surface px-3 py-2 text-xs">
        <div className="flex items-start gap-2">
          <span className="material-symbols-outlined text-[16px] text-green-500" aria-hidden="true">check_circle</span>
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="font-medium text-text-main">Tested with {code(model)}: works</span>
            <span className="text-text-muted">{d.length ? <>{name} rejected {d.map((x, i) => <span key={x}>{i ? ", " : ""}{code(x)}</span>)}, so it&apos;s dropped from now on. The rest go through.</> : "Every beta flag went through."} Cost: 1 token.</span>
          </div>
        </div>
        {droppedChips}
      </div>
    );
  }
  return (
    <div role="status" className="ep-in flex flex-col gap-2 rounded-[8px] border border-border-subtle bg-surface px-3 py-2.5 text-xs">
      <div className="flex items-start gap-2">
        <span className="material-symbols-outlined text-[16px] text-brand-500" aria-hidden="true">auto_fix_high</span>
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="font-medium text-text-main">Beta flags: handled automatically</span>
          <span className="text-text-muted">If {name} rejects one of Claude Code&apos;s beta flags, we drop just that flag, retry, and remember it. Nothing to do. Want to know now instead of on your first message? Send one test message.</span>
          {bc.state === "failed" && <span className="text-red-600 dark:text-red-400">Test failed: {bc.error}</span>}
        </div>
      </div>
      {bc.picking && (
        <div className="flex flex-wrap gap-1.5 pt-1">
          {models.map((m) => (
            <button key={m} type="button" onClick={() => onModel(m)} className={`rounded-full border px-2 py-0.5 font-mono text-[11px] ${m === model ? "border-brand-500/50 bg-brand-500/10 text-text-main" : "border-border-subtle bg-surface text-text-muted hover:text-text-main"}`}>{m}</button>
          ))}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2 pl-6">
        <Btn icon="bolt" variant="secondary" size="sm" onClick={onTest}>Test with {model}</Btn>
        <Btn icon={bc.picking ? "check" : "tune"} variant="ghost" size="sm" onClick={onPick}>{bc.picking ? "Done" : "Pick a model"}</Btn>
        <span className="text-text-subtle">~1 token</span>
      </div>
      {droppedChips}
    </div>
  );
}

// The "On because it rejected max_tokens" reason: detection learned it from a 400.
const mctRejected = (q: ModalQuirks, steps: DetectStep[]) =>
  !!q.maxCompletionTokens && steps.some((s) => /chat\/completions/.test(s.url) && /max_completion_tokens/i.test(s.preview));

export default AddEndpointModal;
