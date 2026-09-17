import { animateCardReflow, captureCardRects } from "./dashboard-layout-motion";

const GUTTER = 16;
const CARD_SELECTOR = "[data-dashboard-card-id]";

export function contentRowSpan(height: number): number {
  return Math.ceil(Math.max(1, Number.isFinite(height) ? height : 1) + GUTTER);
}

function fitCards(grid: HTMLElement, cards: Set<HTMLElement>) {
  // Measure natural border boxes, not animated rectangles or assigned grid areas.
  const updates = [...cards].map((card) => ({
    card,
    span: `span ${contentRowSpan(card.offsetHeight)}`,
  }));
  const before = grid.dataset.contentFit ? captureCardRects(grid) : new Map();
  let changed = false;
  for (const { card, span } of updates) {
    if (card.style.gridRowEnd === span) continue;
    card.style.gridRowEnd = span;
    changed = true;
  }
  grid.dataset.contentFit = "true";
  if (changed) animateCardReflow(grid, before);
}

export function observeContentFit(grid: HTMLElement): () => void {
  if (typeof ResizeObserver === "undefined") return () => undefined;
  const cards = new Set<HTMLElement>();
  let frame: number | undefined;
  const schedule = () => {
    if (frame !== undefined) return;
    frame = requestAnimationFrame(() => {
      frame = undefined;
      fitCards(grid, cards);
    });
  };
  const resize = new ResizeObserver(schedule);
  const sync = () => {
    for (const card of cards) {
      if (card.parentElement === grid) continue;
      resize.unobserve(card);
      cards.delete(card);
    }
    for (const child of grid.children) {
      if (!(child instanceof HTMLElement) || !child.matches(CARD_SELECTOR) || cards.has(child))
        continue;
      cards.add(child);
      resize.observe(child);
    }
    schedule();
  };
  const mutations = new MutationObserver(sync);
  mutations.observe(grid, { childList: true });
  resize.observe(grid);
  sync();
  return () => {
    resize.disconnect();
    mutations.disconnect();
    if (frame !== undefined) cancelAnimationFrame(frame);
  };
}
