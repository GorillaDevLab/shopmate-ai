export type CardRectMap = Map<string, DOMRect>;

const IOS_LAYOUT_EASING = "cubic-bezier(0.32, 0.72, 0, 1)";
const IOS_LAYOUT_DURATION_MS = 260;

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
  if (typeof card.animate !== "function") return;
  card.getAnimations().forEach((animation) => animation.cancel());
  const current = card.getBoundingClientRect();
  const deltaX = previous.left - current.left;
  const deltaY = previous.top - current.top;
  const scaleX = current.width > 0 ? previous.width / current.width : 1;
  const scaleY = current.height > 0 ? previous.height / current.height : 1;
  if (deltaX === 0 && deltaY === 0 && scaleX === 1 && scaleY === 1) return;
  card.animate(
    [
      {
        opacity: 0.96,
        transform: `translate3d(${deltaX}px, ${deltaY}px, 0) scale(${scaleX}, ${scaleY})`,
        transformOrigin: "top left",
      },
      {
        opacity: 1,
        transform: "translate3d(0, 0, 0) scale(1, 1)",
        transformOrigin: "top left",
      },
    ],
    { duration: IOS_LAYOUT_DURATION_MS, easing: IOS_LAYOUT_EASING },
  );
}

function prefersReducedMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}
