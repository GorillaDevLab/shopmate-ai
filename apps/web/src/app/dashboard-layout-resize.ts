import type { DashboardLayoutSize } from "@shopmate/contracts";

export type WidgetFootprint = { columns: 1 | 2; rows: 1 | 2 };

const footprints: Record<DashboardLayoutSize, WidgetFootprint> = {
  "1x1": { columns: 1, rows: 1 },
  "2x1": { columns: 2, rows: 1 },
  "2x2": { columns: 2, rows: 2 },
};

export type CardRectMap = Map<string, DOMRect>;

export function footprintForSize(size: DashboardLayoutSize): WidgetFootprint {
  return footprints[size];
}

export function adjacentAllowedSize(
  size: DashboardLayoutSize,
  direction: -1 | 1,
  allowedSizes: readonly DashboardLayoutSize[],
): DashboardLayoutSize {
  const currentIndex = allowedSizes.findIndex((candidate) => candidate === size);
  if (currentIndex < 0) return allowedSizes[0] ?? size;
  const nextIndex = Math.max(0, Math.min(allowedSizes.length - 1, currentIndex + direction));
  return allowedSizes[nextIndex] ?? size;
}

export function previewWidgetSize({
  startSize,
  deltaX,
  deltaY,
  unitSize,
  allowedSizes,
}: {
  startSize: DashboardLayoutSize;
  deltaX: number;
  deltaY: number;
  unitSize: number;
  allowedSizes: readonly DashboardLayoutSize[];
}): DashboardLayoutSize {
  if (unitSize <= 0 || allowedSizes.length === 0) return startSize;
  const start = footprintForSize(startSize);
  const target = {
    columns: start.columns + deltaX / unitSize,
    rows: start.rows + deltaY / unitSize,
  };
  return allowedSizes.reduce((closest, candidate) => {
    const closestDistance = footprintDistance(footprintForSize(closest), target);
    const candidateDistance = footprintDistance(footprintForSize(candidate), target);
    return candidateDistance < closestDistance ? candidate : closest;
  }, startSize);
}

function footprintDistance(
  footprint: WidgetFootprint,
  target: { columns: number; rows: number },
): number {
  return (footprint.columns - target.columns) ** 2 + (footprint.rows - target.rows) ** 2;
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
