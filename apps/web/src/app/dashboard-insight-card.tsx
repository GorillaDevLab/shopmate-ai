"use client";

import type { DashboardInsightQuery, DashboardInsightResult } from "@shopmate/contracts";
import { useCallback, useEffect, useState } from "react";

import { executeDashboardInsight } from "./dashboard-insight-api";
import { DashboardPieChart } from "./dashboard-pie-chart";
import { DashboardReportCard } from "./dashboard-report-card";

type InsightState =
  | { status: "loading" }
  | { status: "ready"; result: DashboardInsightResult }
  | { status: "error"; message: string };

export function DashboardInsightCard({ query }: { query: DashboardInsightQuery }) {
  const [reloadKey, setReloadKey] = useState(0);
  const [state, setState] = useState<InsightState>({ status: "loading" });
  const retry = useCallback(() => {
    setState({ status: "loading" });
    setReloadKey((key) => key + 1);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void executeDashboardInsight(query, controller.signal).then(
      (result) => setState({ status: "ready", result }),
      (error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setState({ status: "error", message: safeMessage(error) });
      },
    );
    return () => controller.abort();
  }, [query, reloadKey]);

  if (state.status === "loading") return <InsightLoading />;
  if (state.status === "error") return <InsightError message={state.message} onRetry={retry} />;
  if (state.result.kind === "pie") return <DashboardPieChart result={state.result} />;
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
