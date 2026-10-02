/**
 * 回答里的中文日期写法（“8月17日”“8/17”“8月”“15日”）不是经营数字，不应拿去和金额、
 * 订单数比对；但具体到某一天的写法必须落在本轮查询过的日期范围内，防止编造日期。
 */

const DAY_MS = 86_400_000;
const MAX_COVERAGE_DAYS = 800;

const MONTH_DAY = /(?<!\d)(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]/gu;
const SLASH_DATE = /(?<![\d/.])(\d{1,2})\/(\d{1,2})(?![\d/])/gu;
const MONTH_ONLY = /(?<![\d.])(\d{1,2})\s*月份?(?!\s*\d)/gu;
// “近 7 日”是时段长度，不是日期，交给数字核实（时段天数已计入依据）。
const DAY_ONLY = /(?<!(?:近|过去|最近)\s*)(?<![\d.月/])(\d{1,2})\s*[日号](?!\s*均)/gu;

export function stripCalendarReferences(text: string, isoDates: Iterable<string>): string {
  const covered = coveredMonthDays(isoDates);
  const keepIfCovered = (match: string, month: string, day: string) =>
    covered.has(monthDay(Number(month), Number(day))) ? " " : match;
  return text
    .replace(MONTH_DAY, keepIfCovered)
    .replace(SLASH_DATE, keepIfCovered)
    .replace(MONTH_ONLY, (match, month: string) => (inRange(month, 12) ? " " : match))
    .replace(DAY_ONLY, (match, day: string) => (inRange(day, 31) ? " " : match));
}

/** 本轮工具结果与查询参数里出现过的最早到最晚日期之间的每一天（月-日）。 */
function coveredMonthDays(isoDates: Iterable<string>): Set<string> {
  const times = [...isoDates]
    .map((date) => Date.parse(`${date}T00:00:00Z`))
    .filter((time) => Number.isFinite(time));
  const covered = new Set<string>();
  if (times.length === 0) return covered;
  const start = Math.min(...times);
  const end = Math.min(Math.max(...times), start + MAX_COVERAGE_DAYS * DAY_MS);
  for (let time = start; time <= end; time += DAY_MS) {
    const date = new Date(time);
    covered.add(monthDay(date.getUTCMonth() + 1, date.getUTCDate()));
  }
  return covered;
}

function monthDay(month: number, day: number): string {
  return `${month}-${day}`;
}

function inRange(value: string, max: number): boolean {
  const number = Number(value);
  return number >= 1 && number <= max;
}
