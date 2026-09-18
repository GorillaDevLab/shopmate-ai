import {
  DashboardInsightExecuteResponseSchema,
  DashboardInsightGenerateRequestSchema,
  DashboardInsightPreviewResponseSchema,
  type DashboardInsightPreviewResponse,
  type DashboardInsightKind,
  type DashboardChartView,
  type DashboardInsightQuery,
  type DashboardInsightResult,
} from "@shopmate/contracts";

export class DashboardInsightApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryable = false,
    readonly allowedViews?: readonly DashboardChartView[],
  ) {
    super(message);
    this.name = "DashboardInsightApiError";
  }
}

export async function generateDashboardInsight(
  question: string,
  kind: DashboardInsightKind = "auto",
): Promise<DashboardInsightPreviewResponse> {
  const parsedRequest = DashboardInsightGenerateRequestSchema.safeParse({ question, kind });
  if (!parsedRequest.success) {
    throw new DashboardInsightApiError("请输入有效的经营问题后再生成组件", 400, false);
  }
  const body = parsedRequest.data;
  const payload = await requestPreview(body);
  const parsed = DashboardInsightPreviewResponseSchema.safeParse(payload);
  if (!parsed.success) throw invalidResponse();
  return parsed.data;
}

async function requestPreview(body: {
  question: string;
  kind: DashboardInsightKind;
}): Promise<unknown> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(
        new DashboardInsightApiError(
          "图表生成等待超时，结果尚未确认，未自动重试。再次提交可能产生费用。",
          504,
          false,
        ),
      );
      controller.abort();
    }, 180000);
  });
  try {
    // Bound both response headers and body; late results must never add a card.
    return await Promise.race([postInsight("preview", body, controller.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export async function executeDashboardInsight(
  query: DashboardInsightQuery,
  signal?: AbortSignal,
): Promise<DashboardInsightResult> {
  const payload = await postInsight("query", { query }, signal);
  const parsed = DashboardInsightExecuteResponseSchema.safeParse(payload);
  if (!parsed.success) throw invalidResponse();
  return parsed.data.result;
}

async function postInsight(
  path: "preview" | "query",
  body: unknown,
  signal?: AbortSignal,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`/api/v1/ai/dashboard-insights/${path}`, {
      method: "POST",
      credentials: "include",
      cache: "no-store",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
      signal,
    });
  } catch {
    throw new DashboardInsightApiError("无法连接 AI 分析服务，请稍后重试", 0, true);
  }
  const payload = await response.json().catch(() => undefined);
  if (!response.ok) throw responseError(response.status, payload);
  if (payload === undefined) {
    throw invalidResponse();
  }
  return payload;
}

function responseError(status: number, payload: unknown): DashboardInsightApiError {
  if (status === 400 && isCompatibleViewError(payload)) {
    return new DashboardInsightApiError(payload.message, status, false, payload.allowedViews);
  }
  const message = status === 401 ? "登录已失效，请重新登录" : "暂时无法生成经营组件，请重试";
  return new DashboardInsightApiError(message, status, status >= 500);
}

function isCompatibleViewError(payload: unknown): payload is {
  code: "INSIGHT_VIEW_INCOMPATIBLE";
  message: string;
  allowedViews: DashboardChartView[];
} {
  if (!payload || typeof payload !== "object") return false;
  const body = payload as Record<string, unknown>;
  const allowed = body.allowedViews;
  return (
    body.code === "INSIGHT_VIEW_INCOMPATIBLE" &&
    typeof body.message === "string" &&
    Array.isArray(allowed) &&
    allowed.every((view) => ["pie", "bar", "line", "area", "report"].includes(view as string))
  );
}

function invalidResponse(): DashboardInsightApiError {
  return new DashboardInsightApiError("经营组件数据格式异常，请稍后重试", 502, true);
}
