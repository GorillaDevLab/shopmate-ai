import { afterEach, expect, it, vi } from "vitest";
import { contentRowSpan, observeContentFit } from "./dashboard-content-fit";

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

it("rounds up fractional heights without reserving a fixed footprint", () => {
  expect(contentRowSpan(143.2)).toBe(160);
  expect(contentRowSpan(500)).toBe(516);
  expect(contentRowSpan(0)).toBe(17);
  expect(contentRowSpan(Number.NaN)).toBe(17);
});

it("fits growing and shrinking content, batches delivery and cleans up", () => {
  let notify = () => {};
  let frame: FrameRequestCallback | undefined;
  let height = 140;
  const disconnect = vi.fn();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        notify = callback;
      }
      observe() {}
      unobserve() {}
      disconnect = disconnect;
    },
  );
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frame = callback;
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  const grid = document.createElement("section");
  const card = document.createElement("div");
  card.dataset.dashboardCardId = "sales";
  Object.defineProperty(card, "offsetHeight", { get: () => height });
  grid.append(card);
  document.body.append(grid);
  const cleanup = observeContentFit(grid);
  frame?.(0);
  expect(card.style.gridRowEnd).toBe("span 156");
  expect(grid.dataset.contentFit).toBe("true");
  height = 530;
  notify();
  notify();
  frame?.(16);
  expect(card.style.gridRowEnd).toBe("span 546");
  height = 90;
  notify();
  frame?.(32);
  expect(card.style.gridRowEnd).toBe("span 106");
  cleanup();
  expect(disconnect).toHaveBeenCalledOnce();
});

it("leaves a natural CSS fallback when observation is unavailable", () => {
  vi.stubGlobal("ResizeObserver", undefined);
  const grid = document.createElement("section");
  expect(() => observeContentFit(grid)()).not.toThrow();
  expect(grid.dataset.contentFit).toBeUndefined();
});

it("tracks added and removed cards and cancels queued work on unmount", async () => {
  let frame: FrameRequestCallback | undefined;
  const cancel = vi.fn();
  const unobserve = vi.fn();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve = unobserve;
      disconnect() {}
    },
  );
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frame = callback;
    return 7;
  });
  vi.stubGlobal("cancelAnimationFrame", cancel);
  const grid = document.createElement("section");
  const cleanup = observeContentFit(grid);
  frame?.(0);
  const card = document.createElement("div");
  card.dataset.dashboardCardId = "new";
  Object.defineProperty(card, "offsetHeight", { value: 200 });
  grid.append(card);
  await Promise.resolve();
  frame?.(16);
  expect(card.style.gridRowEnd).toBe("span 216");
  card.remove();
  await Promise.resolve();
  expect(unobserve).toHaveBeenCalledWith(card);
  cleanup();
  expect(cancel).toHaveBeenCalledWith(7);
});
