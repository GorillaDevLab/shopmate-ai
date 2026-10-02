import {
  AnalyticsDashboardQuerySchema,
  AnalyticsOverviewResponseSchema,
  type AnalyticsOverviewResponse,
} from "@shopmate/contracts";

import { DashboardApiError, isAbortError } from "../dashboard-api";

export async function fetchAnalyticsOverview(
  asOfDate: string,
  startDate: string,
  signal?: AbortSignal,
): Promise<AnalyticsOverviewResponse> {
  if (!AnalyticsDashboardQuerySchema.safeParse({ asOfDate, startDate }).success) {
    throw new DashboardApiError("统计日期范围无效", 400);
  }
  let response: Response;
  try {
    response = await fetch(
      `/api/v1/analytics/overview?${new URLSearchParams({ asOfDate, startDate })}`,
      {
        credentials: "include",
        cache: "no-store",
        headers: { Accept: "application/json" },
        signal,
      },
    );
  } catch (error) {
    if (isAbortError(error)) throw error;
    throw new DashboardApiError("无法连接经营数据服务，请检查网络后重试", 0);
  }
  if (!response.ok) throw httpError(response.status);
  const parsed = AnalyticsOverviewResponseSchema.safeParse(await readJson(response));
  if (!parsed.success) throw new DashboardApiError("经营分析响应格式异常，请稍后重试", 502);
  if (parsed.data.period.startDate !== startDate || parsed.data.period.endDate !== asOfDate) {
    throw new DashboardApiError("经营分析统计时段不匹配，请重试", 502);
  }
  return parsed.data;
}

function httpError(status: number): DashboardApiError {
  const message =
    status === 401
      ? "登录已失效，请重新登录"
      : status === 400
        ? "统计时段过长，请选择一年以内的日期"
        : status >= 500
          ? "经营数据暂时不可用，请稍后重试"
          : "经营数据请求失败，请刷新后重试";
  return new DashboardApiError(message, status);
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new DashboardApiError("经营分析响应格式异常，请稍后重试", 502);
  }
}
