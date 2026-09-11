export interface ReadToolPeriodInput {
  readonly startDate?: string;
  readonly endDate?: string;
}

export interface ResolvedReadToolPeriod {
  readonly startDate?: string;
  readonly endDate: string;
}

export function resolveReadToolPeriod(
  input: ReadToolPeriodInput,
  now = new Date(),
): ResolvedReadToolPeriod {
  return {
    startDate: input.startDate,
    endDate: input.endDate ?? shanghaiDateKey(now),
  };
}

export function shanghaiDateKey(now: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);

  const read = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";

  return `${read("year")}-${read("month")}-${read("day")}`;
}
