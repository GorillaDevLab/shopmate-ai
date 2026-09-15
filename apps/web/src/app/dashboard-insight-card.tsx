"use client";

import type { DashboardInsightQuery, DashboardInsightResult } from "@shopmate/contracts";
import { useCallback, useEffect, useRef, useState } from "react";

import { executeDashboardInsight } from "./dashboard-insight-api";
import { DashboardComparisonChart } from "./dashboard-comparison-chart";
import { DashboardReportCard } from "./dashboard-report-card";

type InsightState =
  | { status: "loading" }
  | { status: "ready"; result: DashboardInsightResult }
  | { status: "error"; message: string };

export function DashboardInsightCard({
  query,
  initialResult,
}: {
  query: DashboardInsightQuery;
  initialResult?: DashboardInsightResult;
}) {
  const initial = useRef({ key: JSON.stringify(query), result: initialResult });
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
    if (
      reloadKey === 0 &&
      initial.current.result &&
      initial.current.key === JSON.stringify(query)
    ) {
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
  }, [query, reloadKey]);

  if (state.status === "loading") return <InsightLoading />;
  if (state.status === "error") return <InsightError message={state.message} onRetry={retry} />;
  if (state.result.kind === "pie")
    return (
      <DashboardComparisonChart
        key={JSON.stringify(query)}
        result={state.result}
        allowDonut={query.metric !== "averageOrderValue"}
        initialView={query.groupBy === "store" || query.groupBy === "platform" ? "bar" : "donut"}
      />
    );
  return <DashboardReportCard result={state.result} />;
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
