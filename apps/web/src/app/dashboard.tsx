"use client";

import type { AnalyticsDashboardResponse } from "@shopmate/contracts";
import { useState, type ReactNode } from "react";

import { DashboardLayoutEditor } from "./dashboard-layout-editor";
import { AppShell } from "./app-shell";
import { MetricGrid } from "./metric-card";
import { MonitoringRuleManager } from "./monitoring-rule-manager";

export type DashboardState = "ready" | "loading" | "empty" | "error";

interface DashboardProps {
  readonly state?: DashboardState;
  readonly data?: AnalyticsDashboardResponse;
  readonly onRetry?: () => void;
  readonly authRequired?: boolean;
  readonly isRefreshing?: boolean;
  readonly controls?: ReactNode;
  readonly periodLabel?: string;
}

export function Dashboard({
  state = "loading",
  data,
  onRetry,
  authRequired = false,
  isRefreshing = false,
  controls,
  periodLabel = "近 7 天",
}: DashboardProps) {
  const visibleState = state === "ready" && !data ? "empty" : state;
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [monitoringOpen, setMonitoringOpen] = useState(false);
  return (
    <AppShell
      active="dashboard"
      title="经营总览"
      notificationsEnabled={visibleState === "ready"}
      actions={
        <DashboardActions
          assistantOpen={assistantOpen}
          onOpenAssistant={() => setAssistantOpen(true)}
          monitoringOpen={monitoringOpen}
          onOpenMonitoring={() => setMonitoringOpen(true)}
        />
      }
    >
      <div className="mx-auto w-full max-w-[1440px]">
        <section
          aria-label="经营数据"
          className={isRefreshing ? "dashboard-refreshing" : undefined}
          aria-busy={isRefreshing}
        >
          <DashboardIntro
            ready={visibleState === "ready"}
            data={data}
            controls={controls}
            periodLabel={periodLabel}
          />
          {visibleState === "ready" && data ? (
            <DashboardLayoutEditor
              data={data}
              periodLabel={periodLabel}
              assistantOpen={assistantOpen}
              onAssistantOpenChange={setAssistantOpen}
              showAssistant={!authRequired}
              onEditingChange={(editing) => {
                if (editing) setAssistantOpen(false);
              }}
            />
          ) : (
            <>
              <MetricGrid
                metrics={data?.metrics ?? []}
                state={visibleState}
                periodLabel={periodLabel}
              />
              <StatePanel
                state={visibleState === "ready" ? "empty" : visibleState}
                onRetry={onRetry}
                authRequired={authRequired}
              />
            </>
          )}
        </section>
        <footer className="mt-6 border-t border-app-line pt-3 text-xs text-app-muted">
          中文界面 · 移动端优先 · 隐私友好
        </footer>
        <MonitoringRuleManager open={monitoringOpen} onOpenChange={setMonitoringOpen} />
      </div>
    </AppShell>
  );
}

function DashboardActions({
  assistantOpen,
  onOpenAssistant,
  monitoringOpen,
  onOpenMonitoring,
}: {
  assistantOpen: boolean;
  onOpenAssistant: () => void;
  monitoringOpen: boolean;
  onOpenMonitoring: () => void;
}) {
  return (
    <>
      <button
        type="button"
        className="toolbar-button"
        aria-haspopup="dialog"
        aria-expanded={monitoringOpen}
        aria-label="经营监听"
        onClick={onOpenMonitoring}
      >
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          className="size-5 sm:hidden"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
        >
          <circle cx="12" cy="12" r="2" />
          <path d="M7.8 7.8a6 6 0 0 0 0 8.4M16.2 7.8a6 6 0 0 1 0 8.4M5 5a10 10 0 0 0 0 14M19 5a10 10 0 0 1 0 14" />
        </svg>
        <span className="hidden sm:inline">经营监听</span>
      </button>
      <button
        type="button"
        className="toolbar-button is-primary hidden sm:inline-flex"
        aria-haspopup="dialog"
        aria-expanded={assistantOpen}
        onClick={onOpenAssistant}
      >
        AI 助手
      </button>
    </>
  );
}

function DashboardIntro({
  ready,
  data,
  controls,
  periodLabel,
}: {
  ready: boolean;
  data?: AnalyticsDashboardResponse;
  controls?: ReactNode;
  periodLabel: string;
}) {
  return (
    <div className="mb-4 flex flex-col gap-3 md:mb-6 md:flex-row md:items-end md:justify-between">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-tight md:text-2xl">
          {periodLabel}经营，一眼看清
        </h1>
        <p className="mt-1 text-sm text-app-muted">
          <span>{ready ? "数据来自 Analytics API" : "正在连接经营分析服务"}</span>
          {data && (
            <span className="ml-2 border-l border-app-line pl-2">
              统计截至 {formatChineseDate(data.asOfDate)}
            </span>
          )}
        </p>
      </div>
      {controls}
    </div>
  );
}

function StatePanel({
  state,
  onRetry,
  authRequired,
}: {
  state: Exclude<DashboardState, "ready">;
  onRetry?: () => void;
  authRequired: boolean;
}) {
  const copy = {
    loading: ["正在整理你的经营数据…", "很快就能看到最新经营概览。"],
    empty: ["还没有经营数据", "导入第一批商品后，这里会自动生成经营概览。"],
    error: ["数据暂时加载失败", "请检查 API 服务后再试一次。"],
  }[state];
  const isAuthError = state === "error" && authRequired;
  return (
    <div
      className="dashboard-panel mt-4 px-6 py-16 text-center md:mt-6 md:py-20"
      role="status"
      aria-live="polite"
    >
      <div
        aria-hidden="true"
        className="mx-auto grid size-12 place-items-center rounded-xl bg-brand-soft text-xl text-brand"
      >
        {state === "error" ? "!" : state === "loading" ? "…" : "∅"}
      </div>
      <h2 className="mt-5 text-lg font-semibold tracking-tight md:text-xl">{copy[0]}</h2>
      <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-app-muted">
        {isAuthError ? "请先登录后再查看商家经营数据。" : copy[1]}
      </p>
      {state === "error" && (
        <div className="mt-6 flex flex-wrap justify-center gap-3">
          {isAuthError && (
            <a className="btn-primary min-h-11 px-5" href="/login">
              重新登录
            </a>
          )}
          <button type="button" onClick={onRetry} className="btn-secondary min-h-11 px-5">
            重新加载
          </button>
        </div>
      )}
    </div>
  );
}

function formatChineseDate(value: string): string {
  const [year, month, day] = value.split("-");
  return `${year}年${Number(month)}月${Number(day)}日`;
}
