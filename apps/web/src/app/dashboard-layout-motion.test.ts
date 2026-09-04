import { afterEach, describe, expect, it, vi } from "vitest";

import { animateCardReflow, captureCardRects } from "./dashboard-layout-motion";

describe("dashboard layout FLIP motion", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("cancels an interrupted animation before measuring and retargeting", () => {
    const { card, container } = createCard();
    const callOrder: string[] = [];
    const cancel = vi.fn(() => callOrder.push("cancel"));
    const animate = vi.fn(() => {
      callOrder.push("animate");
      return {} as Animation;
    });
    card.getAnimations = vi.fn(() => [{ cancel }] as unknown as Animation[]);
    card.getBoundingClientRect = vi.fn(() => {
      callOrder.push("measure");
      return rect({ left: 240, top: 120, width: 200, height: 200 });
    });
    card.animate = animate;

    animateCardReflow(
      container,
      new Map([["metric-sales", rect({ left: 0, top: 0, width: 100, height: 100 })]]),
    );

    expect(callOrder).toEqual(["cancel", "measure", "animate"]);
    expect(animate).toHaveBeenCalledWith(
      [
        {
          opacity: 0.96,
          transform: "translate3d(-240px, -120px, 0) scale(0.5, 0.5)",
          transformOrigin: "top left",
        },
        {
          opacity: 1,
          transform: "translate3d(0, 0, 0) scale(1, 1)",
          transformOrigin: "top left",
        },
      ],
      { duration: 260, easing: "cubic-bezier(0.32, 0.72, 0, 1)" },
    );
  });

  it("captures card rectangles by stable layout id", () => {
    const { card, container } = createCard();
    const current = rect({ left: 20, top: 30, width: 100, height: 100 });
    card.getBoundingClientRect = vi.fn(() => current);
    expect(captureCardRects(container).get("metric-sales")).toBe(current);
  });

  it("skips unchanged cards, missing old rectangles and unavailable WAAPI", () => {
    const { card, container } = createCard();
    const current = rect({ left: 20, top: 30, width: 100, height: 100 });
    const animate = vi.fn();
    card.getBoundingClientRect = vi.fn(() => current);
    card.getAnimations = vi.fn(() => []);
    card.animate = animate;

    animateCardReflow(container, new Map([["metric-sales", current]]));
    animateCardReflow(container, new Map());
    Object.defineProperty(card, "animate", { configurable: true, value: undefined });
    animateCardReflow(
      container,
      new Map([["metric-sales", rect({ left: 0, top: 0, width: 50, height: 50 })]]),
    );

    expect(animate).not.toHaveBeenCalled();
  });

  it("respects reduced motion", () => {
    const { card, container } = createCard();
    const animate = vi.fn();
    card.animate = animate;
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: true }) as MediaQueryList),
    );

    animateCardReflow(
      container,
      new Map([["metric-sales", rect({ left: 0, top: 0, width: 50, height: 50 })]]),
    );

    expect(animate).not.toHaveBeenCalled();
  });
});

function createCard() {
  const container = document.createElement("section");
  const card = document.createElement("div");
  card.dataset.dashboardCardId = "metric-sales";
  container.append(card);
  return { card, container };
}

function rect(overrides: Partial<DOMRect> = {}): DOMRect {
  return {
    bottom: 0,
    height: 0,
    left: 0,
    right: 0,
    top: 0,
    width: 0,
    x: 0,
    y: 0,
    toJSON: () => ({}),
    ...overrides,
  };
}
