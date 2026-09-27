interface Evidence {
  amounts: number[];
  percentages: number[];
}

const MARKER = "【已验证数值】";

type DerivedPercentCheck = (value: number, precision: number, approximate: boolean) => boolean;

/** Keep presentation conversions local to their unit; never add rounded values to the global evidence set. */
export function protectNumberPresentations(
  content: string,
  outputs: readonly unknown[],
  // 占比、环比可由两个已核实数字直接得出，不要求工具预先返回比例字段。
  isDerivedPercent: DerivedPercentCheck = () => false,
) {
  if (content.includes(MARKER)) return null;
  const evidence: Evidence = { amounts: [], percentages: [] };
  for (const output of outputs) {
    if (isRecord(output) && output.status === "ok") collect(output, evidence);
  }
  const originals: string[] = [];
  let valid = true;
  const masked = content.replace(
    /(约为|大约|约)?\s*([+-]?\d[\d,]*(?:\.\d+)?)\s*(万元|亿元|元|%|％)/gu,
    (match, approximate: string | undefined, digits: string, unit: string) => {
      const percent = unit === "%" || unit === "％";
      const scale = unit === "万元" ? 10000 : unit === "亿元" ? 100000000 : 1;
      const values = percent ? evidence.percentages : evidence.amounts;
      const number = Number(digits.replaceAll(",", ""));
      const precision = digits.split(".")[1]?.length ?? 0;
      const mayRound = Boolean(approximate) || (percent && precision > 0);
      const grounded =
        values.some((value) => matches(value / scale, number, precision, mayRound)) ||
        (percent && isDerivedPercent(Math.abs(number), precision, Boolean(approximate)));
      if (!grounded) valid = false;
      originals.push(match);
      return MARKER;
    },
  );
  let index = 0;
  return valid
    ? { masked, restore: (text: string) => text.replaceAll(MARKER, () => originals[index++] ?? "") }
    : null;
}

function matches(source: number, shown: number, precision: number, mayRound: boolean): boolean {
  if (source === shown) return true;
  // Explicit precision is used, not a broad epsilon that could admit unrelated business values.
  return mayRound && precision <= 8 && Number(source.toFixed(precision)) === shown;
}

/**
 * calculate 工具的结果：百分比类运算计入百分比；差额、合计、平均、单价（ratio）计入金额，
 * 金额同时收录精确到分的值，因为“元”没有更细的单位。
 */
function collectCalculation(value: Record<string, unknown>, evidence: Evidence): void {
  const { operation, result } = value;
  if (typeof operation !== "string" || typeof result !== "number") return;
  if (operation === "percent_change" || operation === "share") {
    evidence.percentages.push(result);
    return;
  }
  evidence.amounts.push(result, Number(result.toFixed(2)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function collect(value: unknown, evidence: Evidence, key = "", currencyRows = false): void {
  if (typeof value === "number" && Number.isFinite(value)) {
    if (key.endsWith("Minor") || (currencyRows && key === "value"))
      evidence.amounts.push(value / 100);
    if (key.endsWith("Yuan")) evidence.amounts.push(value);
    if (key.endsWith("Ratio")) evidence.percentages.push(value * 100);
  } else if (Array.isArray(value)) {
    value.forEach((item) => collect(item, evidence, "", currencyRows));
  } else if (isRecord(value)) {
    collectCalculation(value, evidence);
    for (const [childKey, child] of Object.entries(value)) {
      const rows = value.unit === "currencyMinor" && ["slices", "points"].includes(childKey);
      collect(child, evidence, childKey, rows || currencyRows);
    }
  }
}
