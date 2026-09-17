export type ChartUnit = "currencyMinor" | "count" | "ratio";
export type ChartSlice = { key: string; label: string; value: number };
export type SeriesDatum = { date: string; value: number };
export type PositionedSeriesDatum = SeriesDatum & { x: number; y: number };

const palette = ["#6250d8", "#168477", "#c27a24", "#8b65c9", "#3979a8", "#c35f78"];

export function chartColor(key: string): string {
  if (key.includes("__chart_other__")) return "#9b97a5";
  let hash = 0;
  for (const character of key) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return palette[hash % palette.length]!;
}

export function buildPieSlices(slices: readonly ChartSlice[], expanded = false): ChartSlice[] {
  const sorted = [...slices].sort((a, b) => b.value - a.value || a.key.localeCompare(b.key));
  if (expanded || sorted.length <= 5) return sorted;
  let otherKey = "__chart_other__";
  while (slices.some(({ key }) => key === otherKey)) otherKey = `_${otherKey}`;
  return [
    ...sorted.slice(0, 5),
    {
      key: otherKey,
      label: "其他",
      value: sorted.slice(5).reduce((sum, slice) => sum + slice.value, 0),
    },
  ];
}

export function formatChartValue(value: number, unit: ChartUnit): string {
  if (unit === "currencyMinor") {
    const minor = BigInt(value);
    const currency = new Intl.NumberFormat("zh-CN", {
      style: "currency",
      currency: "CNY",
      currencyDisplay: "narrowSymbol",
      minimumFractionDigits: 2,
    });
    return currency
      .formatToParts(minor / BigInt(100))
      .map((part) =>
        part.type === "fraction" ? String(minor % BigInt(100)).padStart(2, "0") : part.value,
      )
      .join("");
  }
  if (unit === "ratio")
    return `${(value * 100).toLocaleString("zh-CN", { maximumFractionDigits: 1 })}%`;
  return value.toLocaleString("zh-CN", { maximumFractionDigits: 2 });
}

export function formatChartShare(value: number, total: number, additive = true): string | null {
  if (!additive) return null;
  return `${total > 0 ? Math.round((value / total) * 100) : 0}%`;
}

export function createSeriesPoints(points: readonly SeriesDatum[]): PositionedSeriesDatum[] {
  const sorted = [...points].sort((a, b) => a.date.localeCompare(b.date));
  const times = sorted.map((point) => Date.parse(`${point.date}T00:00:00Z`));
  const start = times[0] ?? 0;
  const span = (times.at(-1) ?? start) - start;
  const maximum = Math.max(1, ...sorted.map((point) => point.value));
  return sorted.map((point, index) => ({
    ...point,
    x: span ? 4 + ((times[index]! - start) / span) * 92 : 50,
    y: 94 - (point.value / maximum) * 84,
  }));
}
