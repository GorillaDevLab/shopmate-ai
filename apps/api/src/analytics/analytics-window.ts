import { AnalyticsDashboardQuerySchema } from "@shopmate/contracts";

/** All dashboard sections share inclusive Shanghai calendar dates and equal-length comparisons. */
export function analyticsWindow(asOfDate: string, startDate?: string) {
  const query = AnalyticsDashboardQuerySchema.parse({ asOfDate, startDate });
  const end = Date.parse(query.asOfDate);
  const start = query.startDate ?? new Date(end - 6 * 86_400_000).toISOString().slice(0, 10);
  return {
    startDate: start,
    endDate: query.asOfDate,
    days: (end - Date.parse(start)) / 86_400_000 + 1,
  };
}
