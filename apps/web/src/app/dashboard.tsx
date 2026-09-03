"use client";

import type { AnalyticsDashboardResponse } from "@shopmate/contracts";
import { useState, type ReactNode } from "react";

import { DashboardLayoutEditor } from "./dashboard-layout-editor";
import { MetricGrid } from "./metric-card";
import { ThemeSettings } from "./theme-settings";
import { LogoutButton } from "./logout-button";

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
  return (
    <main className="min-h-dvh bg-app-bg px-4 py-5 text-app-text sm:px-8 lg:py-3">
      <div className="mx-auto w-full max-w-[1440px]">
        <DashboardHeader
          ready={visibleState === "ready"}
          assistantOpen={assistantOpen}
          onOpenAssistant={() => setAssistantOpen(true)}
        />
        <section
          id="main-content"
          className={`mt-8 lg:mt-4 ${isRefreshing ? "dashboard-refreshing" : ""}`}
          aria-busy={isRefreshing}
        >
          <DashboardIntro data={data} controls={controls} periodLabel={periodLabel} />
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
        <footer className="mt-6 border-t border-app-line pt-3 text-xs text-app-muted lg:mt-4">
          中文界面 · 移动端优先 · 隐私友好
        </footer>
      </div>
    </main>
  );
}

function DashboardHeader({
  ready,
  assistantOpen,
  onOpenAssistant,
}: {
  ready: boolean;
  assistantOpen: boolean;
  onOpenAssistant: () => void;
}) {
  return (
    <header className="flex items-center justify-between gap-3 border-b border-app-line pb-3">
      <a
        className="inline-flex min-h-11 items-center gap-3 rounded-full focus-ring"
        href="#main-content"
      >
        <span className="grid size-9 place-items-center rounded-xl bg-brand text-lg font-bold text-white">
          S
        </span>
        <span className="text-base font-bold tracking-tight">ShopMate AI</span>
      </a>
      <div className="flex items-center gap-4 text-right">
        <div className="hidden sm:block">
          <p className="text-sm font-semibold">商家经营看板</p>
          <p className="text-xs text-app-muted">
            {ready ? "数据来自 Analytics API" : "正在连接经营分析服务"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="hidden min-h-11 items-center rounded-xl border border-app-line bg-app-surface px-3 text-sm font-semibold hover:bg-brand-soft sm:inline-flex"
            aria-haspopup="dialog"
            aria-expanded={assistantOpen}
            onClick={onOpenAssistant}
          >
            AI 助手
          </button>
          <LogoutButton />
          <ThemeSettings />
        </div>
      </div>
    </header>
  );
}

function DashboardIntro({
  data,
  controls,
  periodLabel,
}: {
  data?: AnalyticsDashboardResponse;
  controls?: ReactNode;
  periodLabel: string;
}) {
  return (
    <div className="mb-5 flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between lg:mb-4">
      <div>
        <p className="mb-1 text-xs font-semibold tracking-[0.12em] text-app-muted">经营总览</p>
        <h1 className="text-2xl font-semibold tracking-tight sm:text-[28px]">
          {periodLabel}经营，一眼看清
        </h1>
      </div>
      {controls ?? (
        <span className="w-fit rounded-full border border-app-line bg-app-surface px-3 py-1.5 text-xs font-semibold text-app-muted">
          {data ? `统计截至 ${formatChineseDate(data.asOfDate)}` : "正在获取最新数据"}
        </span>
      )}
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
    <div className="dashboard-panel mt-5 px-6 py-20 text-center" role="status" aria-live="polite">
      <div className="mx-auto grid size-12 place-items-center rounded-2xl bg-brand-soft text-xl text-brand">
        ✦
      </div>
      <h2 className="mt-5 text-xl font-black">{copy[0]}</h2>
      <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-app-muted">
        {isAuthError ? "请先登录后再查看商家经营数据。" : copy[1]}
      </p>
      {state === "error" && (
        <div className="mt-6 flex flex-wrap justify-center gap-3">
          {isAuthError && (
            <a
              className="inline-flex min-h-11 items-center rounded-2xl bg-brand px-5 text-sm font-bold text-white transition hover:bg-brand-strong"
              href="/login"
            >
              重新登录
            </a>
          )}
          <button
            type="button"
            onClick={onRetry}
            className="min-h-11 rounded-2xl border border-app-line bg-app-surface px-5 text-sm font-bold text-app-text transition hover:bg-brand-soft"
          >
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
