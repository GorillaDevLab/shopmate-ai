import {
  MetricTimestampSchema,
  MetricWindowSchema,
  type MetricBusinessClock,
  type MetricErrorCode,
  type MetricResult,
  type MetricWindow,
  type MetricWindowRequest,
  type MetricWindowResolver,
  type AlignedComparisonWindow,
} from "@shopmate/contracts";
import { z } from "zod";

const requestSchema = z.strictObject({
  businessDate: z.string(),
  timezone: z.literal("Asia/Shanghai"),
  visibleAt: MetricTimestampSchema,
});
const snapshotSchema = z.strictObject({
  now: MetricTimestampSchema,
  revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
});
const formatter = new Intl.DateTimeFormat("en-US", {
  timeZone: "Asia/Shanghai",
  calendar: "iso8601",
  numberingSystem: "latn",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  fractionalSecondDigits: 3,
  hourCycle: "h23",
});
type CalendarParts = Readonly<{
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  millisecond: number;
}>;
type DayBounds = Readonly<{ start: number; end: number }>;

function failure<T>(code: MetricErrorCode = "INVALID_INPUT"): MetricResult<T> {
  return { ok: false, error: { code, evidenceIds: [] } };
}
function success<T>(value: T): MetricResult<T> {
  return { ok: true, value };
}
function timestamp(value: unknown): number | null {
  const parsed = MetricTimestampSchema.safeParse(value);
  if (!parsed.success) return null;
  const fraction = /\.(\d+)Z$/.exec(parsed.data)?.[1] ?? "";
  if (/[1-9]/.test(fraction.slice(3))) return null;
  const milliseconds = Date.parse(parsed.data);
  return Number.isFinite(milliseconds) ? milliseconds : null;
}
function calendarEpoch(parts: CalendarParts): number {
  const date = new Date(0);
  date.setUTCFullYear(parts.year, parts.month - 1, parts.day);
  date.setUTCHours(parts.hour, parts.minute, parts.second, parts.millisecond);
  return date.getTime();
}
function localParts(milliseconds: number): CalendarParts {
  const parts = formatter.formatToParts(new Date(milliseconds));
  const read = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value);
  return {
    year: read("year"),
    month: read("month"),
    day: read("day"),
    hour: read("hour"),
    minute: read("minute"),
    second: read("second"),
    millisecond: read("fractionalSecond"),
  };
}
function calendarDate(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split("-").map(Number);
  if (year === undefined || month === undefined || day === undefined || year < 1) return null;
  const epoch = calendarEpoch({ year, month, day, hour: 0, minute: 0, second: 0, millisecond: 0 });
  return new Date(epoch).toISOString().slice(0, 10) === value ? epoch : null;
}
function localMidnight(calendar: number): number | null {
  const candidates = new Set<number>();
  // Probe adjacent offsets: DST or historical second offsets must survive an exact roundtrip.
  for (const hours of [-36, -24, -12, 0, 12, 24, 36]) {
    const probe = calendar + hours * 3_600_000;
    const offset = calendarEpoch(localParts(probe)) - probe;
    const candidate = calendar - offset;
    if (calendarEpoch(localParts(candidate)) === calendar) candidates.add(candidate);
  }
  // A missing or ambiguous midnight cannot define a unique business boundary.
  return candidates.size === 1 ? ([...candidates][0] ?? null) : null;
}
function dayBounds(businessDate: string): DayBounds | null {
  const calendar = calendarDate(businessDate);
  if (calendar === null) return null;
  const successor = new Date(calendar);
  successor.setUTCDate(successor.getUTCDate() + 1);
  const start = localMidnight(calendar);
  const end = localMidnight(successor.getTime());
  if (start === null || end === null || !windowValue(start, end).ok) return null;
  return { start, end };
}
function windowValue(start: number, end: number): MetricResult<MetricWindow> {
  const parsed = MetricWindowSchema.safeParse({
    periodStart: new Date(start).toISOString(),
    periodEnd: new Date(end).toISOString(),
    timezone: "Asia/Shanghai",
    currency: "CNY",
  });
  return parsed.success ? success(parsed.data) : failure();
}
function visibility(clock: MetricBusinessClock, visibleAt: unknown): number | null {
  const parsed = snapshotSchema.safeParse(clock.snapshot());
  const visible = timestamp(visibleAt);
  if (!parsed.success || visible === null) return null;
  const now = timestamp(parsed.data.now);
  return now !== null && visible <= now ? visible : null;
}
function requestBounds(clock: MetricBusinessClock, input: MetricWindowRequest) {
  const parsed = requestSchema.safeParse(input);
  if (!parsed.success) return null;
  const visible = visibility(clock, parsed.data.visibleAt);
  const bounds = dayBounds(parsed.data.businessDate);
  return visible !== null && bounds !== null ? { ...bounds, visible } : null;
}

/** Calendar metadata may include a future end; use elapsed() for observed metric queries. */
export function resolveMetricBusinessDay(
  clock: MetricBusinessClock,
  request: MetricWindowRequest,
): MetricResult<MetricWindow> {
  const bounds = requestBounds(clock, request);
  if (!bounds || bounds.start > bounds.visible) return failure();
  return windowValue(bounds.start, bounds.end);
}

export function resolveMetricElapsed(
  clock: MetricBusinessClock,
  request: MetricWindowRequest,
): MetricResult<MetricWindow> {
  const bounds = requestBounds(clock, request);
  if (!bounds) return failure();
  if (bounds.visible <= bounds.start) return failure("WINDOW_MISMATCH");
  return windowValue(bounds.start, Math.min(bounds.end, bounds.visible));
}

function validatedWindow(input: MetricWindow): MetricWindow | null {
  const parsed = MetricWindowSchema.safeParse(input);
  if (
    !parsed.success ||
    timestamp(parsed.data.periodStart) === null ||
    timestamp(parsed.data.periodEnd) === null
  )
    return null;
  return parsed.data;
}

function businessDate(milliseconds: number): string {
  const { year, month, day } = localParts(milliseconds);
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}
function currentBounds(input: MetricWindow, visible: number) {
  const start = Date.parse(input.periodStart);
  const end = Date.parse(input.periodEnd);
  const date = businessDate(start);
  const bounds = dayBounds(date);
  if (!bounds || start !== bounds.start || end > bounds.end || end > visible) return null;
  return { start, end, date };
}
function cutoff(milliseconds: number): string {
  const { hour, minute, second, millisecond } = localParts(milliseconds);
  return `${hour}:${minute}:${second}:${millisecond}`;
}
function weekday(date: string): number {
  return new Date(`${date}T00:00:00.000Z`).getUTCDay();
}
function comparison(
  current: MetricWindow,
  baseline: MetricWindow,
  currentDate: string,
  candidateDate: string,
): AlignedComparisonWindow {
  const elapsed = Date.parse(current.periodEnd) - Date.parse(current.periodStart);
  const baselineElapsed = Date.parse(baseline.periodEnd) - Date.parse(baseline.periodStart);
  const sameCutoff =
    cutoff(Date.parse(current.periodEnd)) === cutoff(Date.parse(baseline.periodEnd));
  const reason =
    weekday(currentDate) !== weekday(candidateDate)
      ? "WEEKDAY_MISMATCH"
      : elapsed !== baselineElapsed || !sameCutoff
        ? "CUTOFF_MISMATCH"
        : null;
  return Object.freeze({
    current,
    baseline,
    elapsedHours: elapsed / 3_600_000,
    aligned: reason === null,
    reason,
  });
}
function alignMetricWindow(
  clock: MetricBusinessClock,
  input: MetricWindow,
  candidateBusinessDate: string,
  visibleAt: string,
): MetricResult<AlignedComparisonWindow> {
  const window = validatedWindow(input);
  if (!window || typeof candidateBusinessDate !== "string") return failure();
  const visible = visibility(clock, visibleAt);
  if (visible === null) return failure();
  const current = currentBounds(window, visible);
  const candidate = dayBounds(candidateBusinessDate);
  if (!current || !candidate || candidateBusinessDate >= current.date) return failure();
  const currentWindow = windowValue(current.start, current.end);
  const end = Math.min(candidate.start + current.end - current.start, candidate.end, visible);
  const baseline = windowValue(candidate.start, end);
  if (!currentWindow.ok || !baseline.ok) return failure();
  return success(
    comparison(currentWindow.value, baseline.value, current.date, candidateBusinessDate),
  );
}

/** Pure window resolution; the injected business clock only fences observation visibility. */
export function createMetricWindowResolver(clock: MetricBusinessClock): MetricWindowResolver {
  return Object.freeze({
    businessDay: (request: MetricWindowRequest) => resolveMetricBusinessDay(clock, request),
    elapsed: (request: MetricWindowRequest) => resolveMetricElapsed(clock, request),
    align: (current: MetricWindow, candidateBusinessDate: string, visibleAt: string) =>
      alignMetricWindow(clock, current, candidateBusinessDate, visibleAt),
  });
}

/** The exclusive end keeps events at midnight in exactly one observed interval. */
export function containsMetricTimestamp(
  input: MetricWindow,
  candidate: string,
): MetricResult<boolean> {
  const window = validatedWindow(input);
  const instant = timestamp(candidate);
  if (window === null || instant === null) return failure();
  return success(
    Date.parse(window.periodStart) <= instant && instant < Date.parse(window.periodEnd),
  );
}
