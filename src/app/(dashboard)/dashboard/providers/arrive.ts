// How a newly added endpoint lands on the providers grid (the "Normal" arrival
// from mockups/provider-setup/src/arrive.js): the other cards slide over to
// their new slots (FLIP), the new card eases in, and it glows pink once.
// Reduced motion gets the glow only. Nothing strobes or repeats.

const EASE = "cubic-bezier(.22,1,.36,1)";
const DURATION = 520;

export type GridSnapshot = Map<Element, DOMRect>;

// React keeps a keyed card's DOM node across re-renders, so the node itself
// identifies the card before and after the new one is inserted.
export function snapshotGrid(grid: Element | null): GridSnapshot {
  const rects: GridSnapshot = new Map();
  for (const el of grid?.children ?? []) rects.set(el, el.getBoundingClientRect());
  return rects;
}

export function findArrivedCard(grid: Element | null, providerId: string): HTMLElement | null {
  return grid?.querySelector<HTMLElement>(`[data-provider-id="${CSS.escape(providerId)}"]`) ?? null;
}

export function arrive(grid: Element, card: HTMLElement, before: GridSnapshot): void {
  const r = card.getBoundingClientRect();
  if (r.top < 70 || r.bottom > window.innerHeight - 70) card.scrollIntoView({ block: "center" });
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    glow(card);
    return;
  }
  for (const el of grid.children) {
    if (el === card) continue;
    const a = before.get(el);
    if (!a) continue;
    const b = el.getBoundingClientRect();
    const dx = a.left - b.left;
    const dy = a.top - b.top;
    if (Math.abs(dx) + Math.abs(dy) < 1) continue;
    el.animate([{ transform: `translate(${dx}px,${dy}px)` }, { transform: "none" }], {
      duration: DURATION,
      easing: EASE,
    });
  }
  card.animate(
    [
      { opacity: 0, transform: "translateY(10px) scale(.97)" },
      { opacity: 1, transform: "none" },
    ],
    { duration: DURATION, delay: 120, easing: EASE, fill: "backwards" },
  );
  glow(card, 160);
}

// On the rounded card surface inside the link, so the ring follows its corners.
function glow(card: HTMLElement, delay = 0): void {
  (card.firstElementChild ?? card).animate(
    [
      { boxShadow: "0 0 0 0 rgb(236 72 153 / 0)" },
      {
        boxShadow: "0 0 0 3px rgb(236 72 153 / .45), 0 8px 30px rgb(236 72 153 / .25)",
        offset: 0.25,
      },
      { boxShadow: "0 0 0 0 rgb(236 72 153 / 0)" },
    ],
    { duration: 1800, delay, easing: "ease-out" },
  );
}
