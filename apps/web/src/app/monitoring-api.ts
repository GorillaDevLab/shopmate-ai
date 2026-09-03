import {
  MonitoringNotificationListResponseSchema,
  MonitoringReadAllResponseSchema,
  MonitoringReadResponseSchema,
  MonitoringRuleCreateRequestSchema,
  MonitoringRuleListResponseSchema,
  MonitoringRulePreviewRequestSchema,
  MonitoringRulePreviewResponseSchema,
  MonitoringRuleResponseSchema,
  MonitoringRuleRunResponseSchema,
  MonitoringRuleStatusRequestSchema,
  MonitoringSyncResponseSchema,
  MonitoringUnreadCountResponseSchema,
  type MonitoringRuleCreateRequest,
} from "@shopmate/contracts";

interface ResponseSchema<T> {
  safeParse(value: unknown): { success: true; data: T } | { success: false };
}

export class MonitoringApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "MonitoringApiError";
  }
}

export async function previewMonitoringRule(question: string) {
  const request = MonitoringRulePreviewRequestSchema.safeParse({ question: question.trim() });
  if (!request.success) throw invalidRequest("请输入你想监听的经营情况");
  return requestJson("rules/preview", MonitoringRulePreviewResponseSchema, "POST", request.data);
}

export async function createMonitoringRule(input: MonitoringRuleCreateRequest) {
  const request = MonitoringRuleCreateRequestSchema.safeParse(input);
  if (!request.success) throw invalidRequest("监听规则格式无效");
  return requestJson("rules", MonitoringRuleResponseSchema, "POST", request.data);
}

export function listMonitoringRules() {
  return requestJson("rules", MonitoringRuleListResponseSchema);
}

export function updateMonitoringRuleStatus(id: string, status: "ACTIVE" | "INACTIVE") {
  const body = MonitoringRuleStatusRequestSchema.parse({ status });
  return requestJson(
    `rules/${encodeURIComponent(id)}/status`,
    MonitoringRuleResponseSchema,
    "PATCH",
    body,
  );
}

export async function deleteMonitoringRule(id: string): Promise<void> {
  await requestRaw(`rules/${encodeURIComponent(id)}`, "DELETE");
}

export function runMonitoringRule(id: string) {
  return requestJson(
    `rules/${encodeURIComponent(id)}/run`,
    MonitoringRuleRunResponseSchema,
    "POST",
  );
}

export function syncMonitoring() {
  return requestJson("sync", MonitoringSyncResponseSchema, "POST");
}

export function listMonitoringNotifications() {
  return requestJson("notifications", MonitoringNotificationListResponseSchema);
}

export function getMonitoringUnreadCount() {
  return requestJson("notifications/unread-count", MonitoringUnreadCountResponseSchema);
}

export function markMonitoringNotificationRead(id: string) {
  return requestJson(
    `notifications/${encodeURIComponent(id)}/read`,
    MonitoringReadResponseSchema,
    "PATCH",
  );
}

export function markAllMonitoringNotificationsRead() {
  return requestJson("notifications/read-all", MonitoringReadAllResponseSchema, "POST");
}

async function requestJson<T>(
  path: string,
  schema: ResponseSchema<T>,
  method = "GET",
  body?: unknown,
) {
  const response = await requestRaw(path, method, body);
  const payload = await response.json().catch(() => {
    throw invalidResponse();
  });
  const parsed = schema.safeParse(payload);
  if (!parsed.success) throw invalidResponse();
  return parsed.data;
}

async function requestRaw(path: string, method: string, body?: unknown): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(`/api/v1/monitoring/${path}`, {
      method,
      credentials: "include",
      cache: "no-store",
      headers: {
        Accept: "application/json",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    throw new MonitoringApiError("无法连接监听服务，请检查网络后重试", 0, true);
  }
  if (!response.ok) throw responseError(response.status);
  return response;
}

function responseError(status: number): MonitoringApiError {
  if (status === 401) return new MonitoringApiError("登录已失效，请重新登录", status, false);
  if (status === 409) return new MonitoringApiError("最多启用 10 条监听规则", status, false);
  return new MonitoringApiError("监听服务暂时不可用，请稍后重试", status, status >= 500);
}

function invalidRequest(message: string) {
  return new MonitoringApiError(message, 400, false);
}

function invalidResponse() {
  return new MonitoringApiError("监听服务返回了无效数据，请稍后重试", 502, true);
}
