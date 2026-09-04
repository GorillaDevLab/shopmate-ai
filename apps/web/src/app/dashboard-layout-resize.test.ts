import { describe, expect, it } from "vitest";

import {
  adjacentAllowedSize,
  footprintForSize,
  previewWidgetSize,
} from "./dashboard-layout-resize";

describe("dashboard layout two-dimensional resizing", () => {
  it("maps every size to its grid footprint", () => {
    expect(footprintForSize("1x1")).toEqual({ columns: 1, rows: 1 });
    expect(footprintForSize("2x1")).toEqual({ columns: 2, rows: 1 });
    expect(footprintForSize("2x2")).toEqual({ columns: 2, rows: 2 });
  });

  it("moves only between sizes allowed by the component", () => {
    expect(adjacentAllowedSize("2x1", 1, ["2x1", "2x2"])).toBe("2x2");
    expect(adjacentAllowedSize("2x1", -1, ["2x1", "2x2"])).toBe("2x1");
  });

  it("chooses the nearest allowed footprint from horizontal and vertical movement", () => {
    expect(
      previewWidgetSize({
        startSize: "1x1",
        deltaX: 180,
        deltaY: 180,
        unitSize: 160,
        allowedSizes: ["1x1", "2x1"],
      }),
    ).toBe("2x1");
    expect(
      previewWidgetSize({
        startSize: "2x1",
        deltaX: 0,
        deltaY: 180,
        unitSize: 160,
        allowedSizes: ["2x1", "2x2"],
      }),
    ).toBe("2x2");
  });

  it("keeps the current size when candidates are equally close", () => {
    expect(
      previewWidgetSize({
        startSize: "1x1",
        deltaX: 80,
        deltaY: 0,
        unitSize: 160,
        allowedSizes: ["1x1", "2x1"],
      }),
    ).toBe("1x1");
  });
});
