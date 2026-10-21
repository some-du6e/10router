"use client";

// The "check known models" step of Add endpoint, as a slot machine. When an
// endpoint has no /models list, detection asks about candidate model ids one
// at a time, PROBE_CONCURRENCY (3) in flight. Each lane here is one of those
// workers: the id it's asking about slides in, then settles struck through
// (not served) or bold (served), and served ids drop into the list beside it.
//
// Driven by the detect route's NDJSON progress events. Answers can come back
// far faster than they can be read, so the visuals run on their own clock: a
// lane shows each id for at least MIN_SHOW_MS. Detection itself never waits;
// when its result arrives the dialog waits for the reel to catch up (capped),
// then shows it. Calm on purpose: lanes only slide, nothing flashes. Reduced
// motion drops the queue and the animations and just fills the list.

import { useEffect, useLayoutEffect, useReducer, useRef } from "react";
import type { DetectProgress } from "@/lib/endpointDetect.js";

export const LANE_H = 22;
const MIN_SHOW_MS = 120;     // an id stays in its lane at least this long before it settles
const HOLD_KNOWN_MS = 160;   // a hit stays bold a little longer
const HOLD_UNKNOWN_MS = 40;
const SWAP_MS = 160;         // old reel fades out before the next one comes in

type LaneState = "run" | "known" | "unknown" | "skipped";
interface LaneView { id: string; state: LaneState; seq: number }
export interface ReelView {
  seq: number;
  protocol: string;
  path: string;
  total: number;
  lanes: (LaneView | null)[];
  found: string[];
  done: number;
  note: { text: string; warn: boolean } | null;
  leaving: boolean;
}
type ModelsDone = Extract<DetectProgress, { type: "models-done" }>;

const STOP_NOTE: Record<string, string> = {
  rate: "still 429 after 3 retries, stopped",
  auth: "401 · the key stopped working, stopped",
  denied: "the key can't use any of these, stopped",
  generated: "it ran a model on an empty request, stopped to avoid charges",
  failing: "kept failing (network or 5xx), stopped",
  deadline: "out of time, stopped",
  aborted: "cancelled",
};

const reduceMotion = () => typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

// Holds what the slot machine shows and when. Events go in with push() as they
// arrive; each is applied at its visual time on one timer. Every lane keeps its
// own clock, and a new reel waits until every lane of the old one has settled.
export class SlotFeed {
  reel: ReelView | null = null;
  private seq = 0;
  private laneFree: number[] = [];
  private laneShown: number[] = [];
  private reelAt = 0;
  private checking = false; // between models-start and models-done, by arrival
  private queue: { t: number; apply: () => void }[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private listeners = new Set<() => void>();
  private waiters: (() => void)[] = [];
  // Called when a reel's last lane has settled, with the server's summary.
  onReelDone: ((e: ModelsDone) => void) | null = null;

  subscribe(fn: () => void) { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }
  private changed() { for (const fn of this.listeners) fn(); }

  reset() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null; this.queue = []; this.reel = null;
    this.laneFree = []; this.laneShown = []; this.reelAt = 0; this.checking = false;
    this.release();
    this.changed();
  }

  private at(t: number, apply: () => void) {
    this.queue.push({ t, apply });
    this.queue.sort((a, b) => a.t - b.t); // stable: same-time events keep arrival order
    this.pump();
  }
  private pump() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const now = Date.now();
    let applied = false;
    while (this.queue.length && this.queue[0].t <= now) { this.queue.shift()!.apply(); applied = true; }
    if (applied) this.changed();
    if (this.queue.length) this.timer = setTimeout(() => this.pump(), this.queue[0].t - now);
    else this.release();
  }
  private release() { const w = this.waiters; this.waiters = []; w.forEach((r) => r()); }

  // Resolves once everything queued has been shown, or after maxWaitMs, when
  // whatever is left is applied at once.
  settled(maxWaitMs = 2500): Promise<void> {
    if (!this.queue.length) return Promise.resolve();
    return new Promise((resolve) => {
      const t = setTimeout(() => this.flush(), maxWaitMs);
      this.waiters.push(() => { clearTimeout(t); resolve(); });
    });
  }
  flush() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const q = this.queue; this.queue = [];
    q.forEach((e) => e.apply());
    this.changed();
    this.release();
  }

  private allFree(now: number) { return Math.max(now, this.reelAt, ...this.laneFree); }

  push(e: DetectProgress) {
    const now = Date.now();
    const calm = reduceMotion();
    if (e.type === "models-start") {
      this.checking = true;
      const swap = this.reel && !calm;
      const start = this.allFree(now);
      if (swap) this.at(start, () => { if (this.reel) this.reel.leaving = true; });
      const t = start + (swap ? SWAP_MS : 0);
      this.reelAt = t;
      this.laneFree = Array(e.lanes).fill(t);
      this.laneShown = Array(e.lanes).fill(t);
      const seq = ++this.seq;
      this.at(t, () => {
        this.reel = { seq, protocol: e.protocol, path: e.path, total: e.total, lanes: Array(e.lanes).fill(null), found: [], done: 0, note: null, leaving: false };
      });
      return;
    }
    if (e.type === "probe") {
      const t = calm ? now : Math.max(now, this.reelAt, this.laneFree[e.lane] ?? 0);
      this.laneShown[e.lane] = t;
      this.laneFree[e.lane] = t + MIN_SHOW_MS; // the result can't land before this
      this.at(t, () => { const r = this.reel; if (r) r.lanes[e.lane] = { id: e.id, state: "run", seq: ++this.seq }; });
      return;
    }
    if (e.type === "probe-result") {
      const t = calm ? now : Math.max(now, (this.laneShown[e.lane] ?? 0) + MIN_SHOW_MS);
      this.laneFree[e.lane] = t + (calm ? 0 : e.known ? HOLD_KNOWN_MS : HOLD_UNKNOWN_MS);
      this.at(t, () => {
        const r = this.reel;
        if (!r) return;
        const lane = r.lanes[e.lane];
        if (lane && lane.id === e.id) r.lanes[e.lane] = { ...lane, state: e.skipped ? "skipped" : e.known ? "known" : "unknown" };
        if (e.skipped) return;
        r.done++;
        if (e.known) r.found = [...r.found, e.id];
      });
      return;
    }
    if (e.type === "throttled") {
      if (!this.checking) return; // a 429 outside model checks shows in the step list
      const secs = Math.max(1, Math.round(e.waitMs / 1000));
      this.at(Math.max(now, this.reelAt), () => { if (this.reel) this.reel.note = { text: `429 Too Many Requests · waiting ${secs}s, then retrying`, warn: true }; });
      return;
    }
    if (e.type === "models-done") {
      this.checking = false;
      const t = this.allFree(now);
      this.laneFree = this.laneFree.map(() => t);
      this.at(t, () => {
        const r = this.reel;
        if (r) {
          r.lanes = r.lanes.map(() => null);
          r.note = e.stopped ? { text: STOP_NOTE[e.stopped] || "stopped", warn: e.stopped !== "aborted" } : r.note?.warn ? { text: "rate limit cleared", warn: false } : r.note;
        }
        this.onReelDone?.(e);
      });
    }
  }
}

function useFeed(feed: SlotFeed) {
  const [, bump] = useReducer((x: number) => x + 1, 0);
  useEffect(() => feed.subscribe(bump), [feed]);
  return feed.reel;
}

function Lane({ view, calm }: { view: LaneView | null; calm: boolean }) {
  const busy = view?.state === "run";
  return (
    <div className={`relative overflow-hidden rounded-[6px] border bg-surface transition-colors duration-150 ${busy ? "border-brand-500/40" : "border-border-subtle"}`} style={{ height: LANE_H }}>
      {view && (
        <div
          key={view.seq}
          className={`absolute inset-x-0 top-0 flex items-center px-2 font-mono text-[10.5px] ${calm ? "" : "ep-slot-in"} ${
            view.state === "known" ? "font-semibold text-text-main"
              : view.state === "unknown" ? "text-text-muted line-through opacity-40"
              : view.state === "skipped" ? "text-text-subtle opacity-40"
              : "text-text-muted"}`}
          style={{ height: LANE_H }}
        >
          <span className="truncate">{view.id}</span>
        </div>
      )}
    </div>
  );
}

function FoundList({ found, calm }: { found: string[]; calm: boolean }) {
  const ref = useRef<HTMLUListElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    el.toggleAttribute("data-at-top", el.scrollTop === 0);
  }, [found.length]);
  return (
    <ul
      ref={ref}
      data-at-top=""
      onScroll={(e) => e.currentTarget.toggleAttribute("data-at-top", e.currentTarget.scrollTop === 0)}
      className="ep-noscroll flex max-h-[76px] flex-col gap-1 overflow-y-auto text-[11px]"
      aria-label="Models found"
    >
      {found.map((id) => (
        <li key={id} className={`flex items-center gap-1.5 ${calm ? "" : "ep-in"}`}>
          <span className={`material-symbols-outlined text-[14px] text-green-500 ${calm ? "" : "ep-pop"}`} aria-hidden="true">check_circle</span>
          <span className="truncate font-mono text-text-main">{id}</span>
        </li>
      ))}
    </ul>
  );
}

export default function SlotMachine({ feed }: { feed: SlotFeed }) {
  const reel = useFeed(feed);
  const calm = reduceMotion();
  const box = useRef<HTMLDivElement>(null);
  const lastH = useRef(0);

  // A new reel (the next API path) may be a different height: ease it.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) { lastH.current = 0; return; }
    const to = el.getBoundingClientRect().height;
    const from = lastH.current;
    lastH.current = to;
    if (calm || !from || Math.abs(from - to) < 1 || !el.animate) return;
    el.style.overflow = "hidden";
    const a = el.animate([{ height: `${from}px` }, { height: `${to}px` }], { duration: 320, easing: "cubic-bezier(0.22, 1, 0.36, 1)" });
    a.onfinish = a.oncancel = () => { el.style.overflow = ""; };
  }, [reel?.seq, calm]);

  if (!reel) return null;
  return (
    <div ref={box}>
      <div
        key={reel.seq}
        className={`flex flex-col gap-2 rounded-[10px] bg-surface-2 p-3 transition-opacity duration-150 ${calm ? "" : "ep-in"} ${reel.leaving ? "opacity-0" : ""}`}
      >
        <div className="flex items-start gap-2 text-xs">
          <span className="material-symbols-outlined text-[16px] text-text-muted" aria-hidden="true">casino</span>
          <div className="flex min-w-0 flex-col">
            <span className="font-medium text-text-main">No /models endpoint found, guessing</span>
            <span className={`text-[11px] ${reel.note?.warn ? "text-yellow-600 dark:text-yellow-400" : "text-text-subtle"}`}>
              {reel.note ? reel.note.text : `${reel.path ? `on ${reel.path} · ` : ""}${reel.lanes.length} at a time`}
            </span>
          </div>
          <span className="ml-auto shrink-0 font-mono text-text-subtle">{reel.done}/{reel.total} · free</span>
        </div>
        <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-3">
          <div className="grid grid-cols-1 gap-1" aria-hidden="true">
            {reel.lanes.map((v, i) => <Lane key={i} view={v} calm={calm} />)}
          </div>
          <FoundList found={reel.found} calm={calm} />
        </div>
      </div>
    </div>
  );
}
