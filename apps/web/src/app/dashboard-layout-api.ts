import {
  DashboardLayoutReadResponseSchema,
  DashboardLayoutSaveRequestSchema,
  type DashboardLayoutReadResponse,
  type DashboardLayoutSaveRequest,
} from "@shopmate/contracts";

export class DashboardLayoutApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "DashboardLayoutApiError";
  }
}

export function fetchDashboardLayout(signal?: AbortSignal): Promise<DashboardLayoutReadResponse> {
  return requestLayout("GET", signal);
}

export function saveDashboardLayout(
  request: DashboardLayoutSaveRequest,
  signal?: AbortSignal,
): Promise<DashboardLayoutReadResponse> {
  const parsed = DashboardLayoutSaveRequestSchema.safeParse(request);
  if (!parsed.success) {
    return Promise.reject(new DashboardLayoutApiError("看板布局格式无效", 400, false));
  }
  return requestLayout("PUT", signal, JSON.stringify(parsed.data));
}

async function requestLayout(
  method: "GET" | "PUT",
  signal?: AbortSignal,
  body?: string,
): Promise<DashboardLayoutReadResponse> {
  let response: Response;
  try {
    response = await fetch("/api/v1/dashboard/layout", {
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
    throw new DashboardLayoutApiError("无法连接布局服务，请检查网络后重试", 0, true);
  }

  if (!response.ok) throwHttpError(response.status);
  const payload = await readJson(response);
  const parsed = DashboardLayoutReadResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new DashboardLayoutApiError("布局服务响应格式异常", 502, true);
  }
  return parsed.data;
}

function throwHttpError(status: number): never {
  if (status === 401) {
    throw new DashboardLayoutApiError("登录已失效，请重新登录", status, false);
  }
  if (status === 409) {
    throw new DashboardLayoutApiError("布局已在其他设备更新，你的草稿仍然保留", status, true);
  }
  if (status === 400) {
    throw new DashboardLayoutApiError("看板布局格式无效", status, false);
  }
  throw new DashboardLayoutApiError("布局服务暂时不可用，请稍后重试", status, true);
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new DashboardLayoutApiError("布局服务响应格式异常", 502, true);
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}
