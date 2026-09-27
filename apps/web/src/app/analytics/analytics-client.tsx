"use client";

import type { AnalyticsOverviewResponse } from "@shopmate/contracts";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { SEARCH_MAX_LENGTH } from "../app-shell";
import { useAssistantWorkspace } from "../assistant/provider";
import { isAbortError } from "../dashboard-api";
import { shanghaiToday } from "../dashboard-range";
import { daysBefore, type DashboardRange } from "../dashboard-range";
import { fetchAnalyticsOverview } from "./analytics-api";
import { AnalyticsView, type OverviewState } from "./analytics-view";
import { useAnalyticsLayout } from "./use-analytics-layout";

const DEFAULT_DAYS = 30;

export function AnalyticsClient({ asOfDate = shanghaiToday() }: { asOfDate?: string }) {
  const [range, setRange] = useState<DashboardRange>({
    kind: "30",
    endDate: asOfDate,
    startDate: daysBefore(asOfDate, DEFAULT_DAYS - 1),
  });
  const { state, refreshing, retry } = useAnalyticsOverview(
    range.endDate,
    range.startDate ?? daysBefore(range.endDate, 6),
  );
  return (
    <AnalyticsView
      state={state}
      refreshing={refreshing}
      range={range}
      latestDate={asOfDate}
      onRangeChange={setRange}
      onRetry={retry}
      onAsk={useAskAssistant()}
      editor={useAnalyticsLayout()}
    />
  );
}

type Result = { readonly key: string; readonly state: OverviewState };

/** 切换时段时保留上一次的数据并标记刷新中，避免整页闪回骨架屏。 */
export function useAnalyticsOverview(asOfDate: string, startDate: string) {
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<Result | null>(null);
  const key = `${startDate}/${asOfDate}/${attempt}`;

  useEffect(() => {
    const controller = new AbortController();
    fetchAnalyticsOverview(asOfDate, startDate, controller.signal).then(
      (data: AnalyticsOverviewResponse) => setResult({ key, state: { status: "ready", data } }),
      (error: unknown) => {
        if (isAbortError(error)) return;
        setResult({ key, state: toErrorState(error) });
      },
    );
    return () => controller.abort();
  }, [key, asOfDate, startDate]);

  const settled = result?.key === key;
  const stale = !settled && result?.state.status === "ready" ? result.state : null;
  const state: OverviewState = settled ? result.state : (stale ?? { status: "loading" });
  return { state, refreshing: !settled && stale !== null, retry: () => setAttempt((n) => n + 1) };
}

function toErrorState(error: unknown): OverviewState {
  const status =
    error instanceof Error ? (error as Error & { status?: unknown }).status : undefined;
  return {
    status: "error",
    authRequired: status === 401,
    message: error instanceof Error ? error.message : "经营数据暂时不可用，请稍后重试",
  };
}

/** 只把问题写入助手草稿再跳转，由商家确认后发送，不替商家自动提问。 */
function useAskAssistant() {
  const router = useRouter();
  const { store } = useAssistantWorkspace();
  return (question: string) => {
    store.setDraft(question.slice(0, SEARCH_MAX_LENGTH));
    router.push("/chat");
  };
}
