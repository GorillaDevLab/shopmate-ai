"use client";

import type { DashboardInsightQuery, DashboardInsightResult } from "@shopmate/contracts";
import { useCallback, useEffect, useRef, useState } from "react";

import { executeDashboardInsight } from "./dashboard-insight-api";
import { DashboardInsightPresentation } from "./dashboard-insight-presentation";
import type { DashboardChartView } from "@shopmate/contracts";

type InsightState =
  | { status: "loading" }
  | { status: "ready"; result: DashboardInsightResult }
  | { status: "error"; message: string };

export function DashboardInsightCard({
  query,
  initialResult,
  view,
  onViewChange,
}: {
  query: DashboardInsightQuery;
  initialResult?: DashboardInsightResult;
  view?: DashboardChartView;
  onViewChange?: (view: DashboardChartView) => void;
}) {
  const queryKey = JSON.stringify(query);
  const initial = useRef({ key: queryKey, result: initialResult });
  const [reloadKey, setReloadKey] = useState(0);
  const [state, setState] = useState<InsightState>(
    initialResult ? { status: "ready", result: initialResult } : { status: "loading" },
  );
  const retry = useCallback(() => {
    setState({ status: "loading" });
    setReloadKey((key) => key + 1);
  }, []);

  useEffect(() => {
    // Preview already executed this query; layout edits must not run it again.
    if (reloadKey === 0 && initial.current.result && initial.current.key === queryKey) {
      setState({ status: "ready", result: initial.current.result });
      return;
    }
    const controller = new AbortController();
    setState({ status: "loading" });
    void executeDashboardInsight(query, controller.signal).then(
      (result) => {
        if (!controller.signal.aborted) setState({ status: "ready", result });
      },
      (error: unknown) => {
        if (
          controller.signal.aborted ||
          (error instanceof DOMException && error.name === "AbortError")
        )
          return;
        setState({ status: "error", message: safeMessage(error) });
      },
    );
    return () => controller.abort();
  }, [query, queryKey, reloadKey]);

  if (state.status === "loading") return <InsightLoading />;
  if (state.status === "error") return <InsightError message={state.message} onRetry={retry} />;
  return (
    <DashboardInsightPresentation
      result={state.result}
      view={view}
      onViewChange={onViewChange}
      allowDonut={query.metric !== "averageOrderValue"}
    />
  );
}

function InsightLoading() {
  return (
    <section className="dashboard-insight dashboard-insight-loading" aria-busy="true">
      <span />
      <span />
      <p>正在更新 AI 分析…</p>
    </section>
  );
}

function InsightError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <section className="dashboard-insight dashboard-insight-error" role="alert">
      <strong>组件数据加载失败</strong>
      <p>{message}</p>
      <button type="button" onClick={onRetry}>
        重新加载
      </button>
    </section>
  );
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message : "暂时无法读取经营数据";
}
