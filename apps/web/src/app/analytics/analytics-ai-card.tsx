"use client";

import type {
  AnalyticsAiCard,
  DashboardInsightQuery,
  DashboardInsightResult,
} from "@shopmate/contracts";
import { useEffect, useState } from "react";

import { isAbortError } from "../dashboard-api";
import { executeDashboardInsight } from "../dashboard-insight-api";
import { ChartCard } from "./analytics-panels";
import { ExploreChart } from "./explore/explore-chart";
import { isEmptyResult } from "./explore/explore-model";

type Period = { readonly startDate: string; readonly endDate: string };
type CardState =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly result: DashboardInsightResult }
  | { readonly status: "error"; readonly message: string };

/** 保存的 AI 图表跟随页面时段：沿用保存时的指标与分组，只把日期换成当前时段。 */
export function queryForPeriod(
  query: DashboardInsightQuery,
  period: Period,
): DashboardInsightQuery {
  return { ...query, dateRange: { start: period.startDate, end: period.endDate } };
}

export function AiChartCard({
  card,
  period,
  onAsk,
}: {
  card: AnalyticsAiCard;
  period: Period;
  onAsk: (question: string) => void;
}) {
  const query = queryForPeriod(card.query, period);
  const { state, retry } = useInsightResult(query);
  return (
    <ChartCard
      title={card.title}
      onAsk={() => onAsk(`帮我解读「${card.title}」这张图表，有什么值得注意的？`)}
    >
      {state.status === "loading" && (
        <p className="card-note" role="status">
          正在查询…
        </p>
      )}
      {state.status === "error" && (
        <div className="card-note" role="alert">
          <p>{state.message}</p>
          <button type="button" className="btn-secondary" onClick={retry}>
            重试
          </button>
        </div>
      )}
      {state.status === "ready" &&
        (isEmptyResult(state.result) ? (
          <p className="card-note">这个时段没有可展示的数据。</p>
        ) : (
          <ExploreChart result={state.result} view={query.visualization} />
        ))}
    </ChartCard>
  );
}

/** 只执行结构化查询，不调用模型；时段或查询变化时中止上一次请求。 */
function useInsightResult(query: DashboardInsightQuery) {
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ key: string; state: CardState } | null>(null);
  // 以序列化后的查询作为依赖：每次渲染都会生成新的 query 对象，但内容不变时不应重新请求。
  const serialized = JSON.stringify(query);
  const key = `${serialized}#${attempt}`;

  useEffect(() => {
    const controller = new AbortController();
    const request = JSON.parse(serialized) as DashboardInsightQuery;
    executeDashboardInsight(request, controller.signal).then(
      (data) => setResult({ key, state: { status: "ready", result: data } }),
      (error: unknown) => {
        if (isAbortError(error)) return;
        const message = error instanceof Error ? error.message : "图表暂时无法加载";
        setResult({ key, state: { status: "error", message } });
      },
    );
    return () => controller.abort();
  }, [key, serialized]);

  const state: CardState = result?.key === key ? result.state : { status: "loading" };
  return { state, retry: () => setAttempt((n) => n + 1) };
}
