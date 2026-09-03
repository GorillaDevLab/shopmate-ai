import type { MonitoringFrequency, MonitoringRuleDefinition } from "@shopmate/contracts";

const DAY_MS = 24 * 60 * 60 * 1000;
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;

export function nextRunAt(frequency: MonitoringFrequency, completedAt: Date): Date {
  return new Date(completedAt.getTime() + (frequency === "daily" ? DAY_MS : 7 * DAY_MS));
}

export function monitoringPeriod(
  window: Extract<MonitoringRuleDefinition, { kind: "salesThreshold" }>["window"],
  now: Date,
) {
  const days = Number.parseInt(window, 10);
  const endDate = shanghaiDateKey(now);
  const startDate = addDays(endDate, -(days - 1));
  return {
    startDate,
    endDate,
    periodStart: `${startDate}T00:00:00.000Z`,
    periodEnd: `${endDate}T23:59:59.999Z`,
  };
}

export function inventoryPeriod(now: Date) {
  const date = shanghaiDateKey(now);
  return {
    startDate: date,
    endDate: date,
    periodStart: `${date}T00:00:00.000Z`,
    periodEnd: `${date}T23:59:59.999Z`,
  };
}

function shanghaiDateKey(date: Date): string {
  return new Date(date.getTime() + SHANGHAI_OFFSET_MS).toISOString().slice(0, 10);
}

function addDays(date: string, days: number): string {
  return new Date(`${date}T00:00:00.000Z`).toISOString().slice(0, 10) === date
    ? new Date(Date.parse(`${date}T00:00:00.000Z`) + days * DAY_MS).toISOString().slice(0, 10)
    : invalidDate();
}

function invalidDate(): never {
  throw new RangeError("invalid monitoring date");
}
