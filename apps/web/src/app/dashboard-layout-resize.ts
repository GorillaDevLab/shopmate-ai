import type { DashboardLayoutSize } from "@shopmate/contracts";

export type WidgetFootprint = { columns: 1 | 2; rows: 1 | 2 };

const footprints: Record<DashboardLayoutSize, WidgetFootprint> = {
  "1x1": { columns: 1, rows: 1 },
  "2x1": { columns: 2, rows: 1 },
  "2x2": { columns: 2, rows: 2 },
};

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
