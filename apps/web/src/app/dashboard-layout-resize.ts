import type { DashboardLayoutSize } from "@shopmate/contracts";

export const DASHBOARD_COLUMN_COUNT = 12;
export const MINIMUM_CARD_SPAN = 4;

const sizeStops = [
  { size: "1/3", span: 4 },
  { size: "1/2", span: 6 },
  { size: "2/3", span: 8 },
  { size: "full", span: 12 },
] as const satisfies ReadonlyArray<{ size: DashboardLayoutSize; span: number }>;

export type CardRectMap = Map<string, DOMRect>;

export function spanForSize(size: DashboardLayoutSize): number {
  return sizeStops.find((stop) => stop.size === size)?.span ?? MINIMUM_CARD_SPAN;
}

export function sizeForSpan(span: number): DashboardLayoutSize {
  return sizeStops.reduce((closest, candidate) =>
    Math.abs(candidate.span - span) <= Math.abs(closest.span - span) ? candidate : closest,
  ).size;
}

export function adjacentSize(size: DashboardLayoutSize, direction: -1 | 1): DashboardLayoutSize {
  const currentIndex = sizeStops.findIndex((stop) => stop.size === size);
  const nextIndex = Math.max(0, Math.min(sizeStops.length - 1, currentIndex + direction));
  return sizeStops[nextIndex]?.size ?? size;
}

export function previewSpan(
  startSpan: number,
  startX: number,
  currentX: number,
  gridWidth: number,
): number {
  if (gridWidth <= 0) return startSpan;
  const deltaColumns = Math.round(((currentX - startX) / gridWidth) * DASHBOARD_COLUMN_COUNT);
  return Math.max(MINIMUM_CARD_SPAN, Math.min(DASHBOARD_COLUMN_COUNT, startSpan + deltaColumns));
}

export function captureCardRects(container: HTMLElement | null): CardRectMap {
  const rects: CardRectMap = new Map();
  container?.querySelectorAll<HTMLElement>("[data-dashboard-card-id]").forEach((card) => {
    const cardId = card.dataset.dashboardCardId;
    if (cardId) rects.set(cardId, card.getBoundingClientRect());
  });
  return rects;
}

export function animateCardReflow(container: HTMLElement | null, before: CardRectMap): void {
  if (!container || prefersReducedMotion()) return;
  container.querySelectorAll<HTMLElement>("[data-dashboard-card-id]").forEach((card) => {
    const previous = before.get(card.dataset.dashboardCardId ?? "");
    if (previous) animateCardFromPreviousPosition(card, previous);
  });
}

function animateCardFromPreviousPosition(card: HTMLElement, previous: DOMRect): void {
  const current = card.getBoundingClientRect();
  const deltaX = previous.left - current.left;
  const deltaY = previous.top - current.top;
  if ((!deltaX && !deltaY) || typeof card.animate !== "function") return;
  card.getAnimations().forEach((animation) => animation.cancel());
  card.animate(
    [
      { transform: `translate3d(${deltaX}px, ${deltaY}px, 0)` },
      { transform: "translate3d(0, 0, 0)" },
    ],
    { duration: 210, easing: "cubic-bezier(0.23, 1, 0.32, 1)" },
  );
}

function prefersReducedMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}
