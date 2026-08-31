import {
  AnalyticsDashboardResponseSchema,
  type AnalyticsDashboardResponse,
} from "@shopmate/contracts";

export class DashboardApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "DashboardApiError";
  }
}

export async function fetchDashboard(
  asOfDate: string,
  signal?: AbortSignal,
): Promise<AnalyticsDashboardResponse> {
  let response: Response;
  try {
    response = await fetch(`/api/v1/analytics/dashboard?asOfDate=${encodeURIComponent(asOfDate)}`, {
      credentials: "include",
      cache: "no-store",
      headers: { Accept: "application/json" },
      signal,
    });
  } catch (error) {
    if (isAbortError(error)) throw error;
    throw new DashboardApiError("无法连接经营数据服务，请检查网络后重试", 0);
  }

  if (!response.ok) throwHttpError(response.status);

  const payload = await readJson(response);
  const parsed = AnalyticsDashboardResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new DashboardApiError("经营数据响应格式异常，请稍后重试", 502);
  }
  return parsed.data;
}

function throwHttpError(status: number): never {
  const message =
    status === 401
      ? "登录已失效，请重新登录"
      : status >= 500
        ? "经营数据暂时不可用，请稍后重试"
        : "经营数据请求失败，请刷新后重试";
  throw new DashboardApiError(message, status);
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new DashboardApiError("经营数据响应格式异常，请稍后重试", 502);
  }
}

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}
