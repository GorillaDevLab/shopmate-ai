import {
  AnalyticsLayoutReadResponseSchema,
  AnalyticsLayoutSaveRequestSchema,
  type AnalyticsLayout,
  type AnalyticsLayoutReadResponse,
} from "@shopmate/contracts";

import { DashboardApiError, isAbortError } from "../dashboard-api";

const ENDPOINT = "/api/v1/analytics/layout";

export function fetchAnalyticsLayout(signal?: AbortSignal): Promise<AnalyticsLayoutReadResponse> {
  return request("GET", signal);
}

export function saveAnalyticsLayout(
  layout: AnalyticsLayout,
  expectedRevision: number,
): Promise<AnalyticsLayoutReadResponse> {
  const body = AnalyticsLayoutSaveRequestSchema.safeParse({ layout, expectedRevision });
  if (!body.success) return Promise.reject(new DashboardApiError("布局格式无效", 400));
  return request("PUT", undefined, JSON.stringify(body.data));
}

async function request(
  method: "GET" | "PUT",
  signal?: AbortSignal,
  body?: string,
): Promise<AnalyticsLayoutReadResponse> {
  let response: Response;
  try {
    response = await fetch(ENDPOINT, {
      method,
      credentials: "include",
      cache: "no-store",
      headers: {
        Accept: "application/json",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body,
      signal,
    });
  } catch (error: unknown) {
    if (isAbortError(error)) throw error;
    throw new DashboardApiError("无法连接布局服务，请检查网络后重试", 0);
  }
  if (!response.ok) throw httpError(response.status);
  const parsed = AnalyticsLayoutReadResponseSchema.safeParse(
    await response.json().catch(() => null),
  );
  if (!parsed.success) throw new DashboardApiError("布局服务响应格式异常", 502);
  return parsed.data;
}

function httpError(status: number): DashboardApiError {
  const message =
    status === 401
      ? "登录已失效，请重新登录"
      : status === 409
        ? "布局已在其他设备更新，你的修改还在，刷新页面后可重新编辑"
        : status === 400
          ? "布局格式无效"
          : "布局服务暂时不可用，请稍后重试";
  return new DashboardApiError(message, status);
}
