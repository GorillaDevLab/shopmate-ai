import {
  DashboardInsightExecuteResponseSchema,
  DashboardInsightPreviewResponseSchema,
  type DashboardInsightPreviewResponse,
  type DashboardInsightQuery,
  type DashboardInsightResult,
} from "@shopmate/contracts";

export class DashboardInsightApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "DashboardInsightApiError";
  }
}

export async function generateDashboardInsight(
  question: string,
  kind: "pie" | "report",
): Promise<DashboardInsightPreviewResponse> {
  const payload = await requestPreview({ question: question.trim(), kind });
  const parsed = DashboardInsightPreviewResponseSchema.safeParse(payload);
  if (!parsed.success) throw invalidResponse();
  return parsed.data;
}

async function requestPreview(body: {
  question: string;
  kind: "pie" | "report";
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
  if (!response.ok) throw responseError(response.status);
  return response.json().catch(() => {
    throw invalidResponse();
  });
}

function responseError(status: number): DashboardInsightApiError {
  const message = status === 401 ? "登录已失效，请重新登录" : "暂时无法生成经营组件，请重试";
  return new DashboardInsightApiError(message, status, status >= 500);
}

function invalidResponse(): DashboardInsightApiError {
  return new DashboardInsightApiError("经营组件数据格式异常，请稍后重试", 502, true);
}
