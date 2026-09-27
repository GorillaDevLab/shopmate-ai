/**
 * 判断回答中的数字是否有工具结果作为依据。
 *
 * 规则依旧严格：每个数字都必须能追溯到本轮工具结果。普通数字要求完全一致
 * （约数由 number-presentation 按单位单独核对，并要求写明“约”）；百分比与倍数
 * 额外接受“由两个已核实数字直接得出”的占比、环比和倍数，按回答给出的小数位比对。
 * 差额、合计、平均等其他推算必须先调用 calculate 工具，结果才会成为依据。
 */

type Suffix = "" | "%" | "倍" | "万" | "亿";

export interface AnswerNumber {
  readonly text: string;
  readonly value: number;
  readonly decimals: number;
  readonly suffix: Suffix;
  /** 回答写明了“约”，允许四舍五入到给出的精度（整数时为个位）。 */
  readonly approximate?: boolean;
}

const SCALE: Partial<Record<Suffix, number>> = { 万: 10_000, 亿: 100_000_000 };

export class NumericGrounding {
  private readonly values: readonly number[];
  private readonly exact: ReadonlySet<string>;

  constructor(evidence: Iterable<string>) {
    const values = new Set<number>();
    for (const item of evidence) {
      // 回答里的数字不带正负号（“下降 12%”），因此按绝对值比对。
      const value = Math.abs(Number(item));
      if (Number.isFinite(value)) values.add(value);
    }
    this.values = [...values].sort((a, b) => a - b);
    this.exact = new Set(this.values.map(canonical));
  }

  isGrounded(number: AnswerNumber): boolean {
    const scale = SCALE[number.suffix];
    if (scale) return this.exact.has(canonical(number.value * scale));
    if (this.exact.has(canonical(number.value))) return true;
    if (number.suffix !== "%" && number.suffix !== "倍") return false;
    const [low, high] = precisionRange(number);
    if (this.hasValueIn(low, high)) return true;
    if (number.suffix === "倍") return this.isRatio(low, high, 1);
    return this.isRatio(low, high, 100) || this.isChange(low, high);
  }

  /** value ≈ a / b × factor，a、b 都是已核实数字。 */
  private isRatio(low: number, high: number, factor: number): boolean {
    if (high <= 0) return false;
    return this.values.some(
      (a) => a > 0 && this.hasValueIn((a * factor) / high, low > 0 ? (a * factor) / low : Infinity),
    );
  }

  /** value ≈ |a − b| / b × 100，即以 b 为基期的变化幅度。 */
  private isChange(low: number, high: number): boolean {
    return this.values.some((a) => {
      if (a <= 0) return false;
      const increase = this.hasValueIn(a / (1 + high / 100), a / (1 + low / 100));
      const decrease = high < 100 && this.hasValueIn(a / (1 - low / 100), a / (1 - high / 100));
      return increase || decrease;
    });
  }

  private hasValueIn(low: number, high: number): boolean {
    let left = 0;
    let right = this.values.length;
    while (left < right) {
      const middle = (left + right) >> 1;
      if (this.values[middle] < low) left = middle + 1;
      else right = middle;
    }
    return left < this.values.length && this.values[left] <= high;
  }
}

/** 写了几位小数就按几位比对；整数百分比不做四舍五入（约数需写“约”）。 */
function precisionRange({ value, decimals, approximate }: AnswerNumber): [number, number] {
  const half = decimals > 0 || approximate ? 0.5 * 10 ** -decimals : 1e-9;
  return [Math.max(0, value - half), value + half - 1e-12];
}

function canonical(value: number): string {
  return String(Number(value.toFixed(8)));
}

const NUMBER_PATTERN = /(\d[\d,]*(?:\.\d+)?)\s*(%|％|倍|万|亿)?/gu;

export function extractAnswerNumbers(text: string): AnswerNumber[] {
  return [...text.matchAll(NUMBER_PATTERN)].map((match) => {
    const raw = match[1].replaceAll(",", "");
    const suffix = match[2] === "％" ? "%" : ((match[2] ?? "") as Suffix);
    return {
      text: match[0],
      value: Number(raw),
      decimals: raw.includes(".") ? raw.length - raw.indexOf(".") - 1 : 0,
      suffix,
    };
  });
}

/** 百分比数字（不含 % 号）是否由已核实数字直接得出；供按单位核对的呈现检查使用。 */
export function isDerivedPercent(
  grounding: NumericGrounding,
  value: number,
  decimals: number,
  approximate: boolean,
): boolean {
  return grounding.isGrounded({ text: `${value}%`, value, decimals, suffix: "%", approximate });
}
