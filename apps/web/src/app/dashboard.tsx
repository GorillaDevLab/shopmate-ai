"use client";

import type { AnalyticsDashboardResponse } from "@shopmate/contracts";
import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";

import { DashboardLayoutEditor } from "./dashboard-layout-editor";
import { MetricGrid } from "./metric-card";
import { DashboardNavigation } from "./dashboard-navigation";
import { MonitoringRuleManager } from "./monitoring-rule-manager";
import { NotificationCenter } from "./notification-center";
import { AppearanceProvider } from "./appearance-provider";
import { AppearanceAmbient, AppearanceControls } from "./appearance-controls";
import { useAssistantWorkspace } from "./assistant/provider";
import { ToolbarSearch, UserBadge } from "./toolbar-search";

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

export function Dashboard(props: DashboardProps) {
  return (
    <AppearanceProvider>
      <DashboardWorkspace {...props} />
    </AppearanceProvider>
  );
}

function DashboardWorkspace({
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
  const { store } = useAssistantWorkspace();
  const router = useRouter();
  // 顶部搜索只写入助手草稿，由商家确认后再发送；看板未就绪时抽屉不挂载，改去完整对话页。
  const searchWithAssistant = (query: string) => {
    store.setDraft(query);
    if (visibleState === "ready" && !authRequired) setAssistantOpen(true);
    else router.push("/chat");
  };
  return (
    <main className="workspace-layout min-h-dvh bg-app-bg text-app-text">
      <AppearanceAmbient />
      <DashboardNavigation
        onAssistant={() => setAssistantOpen(true)}
        onMonitoring={() => setMonitoringOpen(true)}
      />
      <div className="workspace-content">
        <DashboardHeader ready={visibleState === "ready"} onSearch={searchWithAssistant} />
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
        <MonitoringRuleManager open={monitoringOpen} onOpenChange={setMonitoringOpen} />
      </div>
    </main>
  );
}

function DashboardHeader({
  ready,
  onSearch,
}: {
  ready: boolean;
  onSearch: (query: string) => void;
}) {
  return (
    <header className="workspace-topbar flex items-center justify-between gap-3 border-b border-app-line pb-3">
      <a className="workspace-breadcrumb focus-ring" href="#main-content">
        工作台 <span aria-hidden="true">/</span>
        <strong className="font-semibold">经营总览</strong>
      </a>
      <AppearanceControls />
      <ToolbarSearch onSearch={onSearch} className="hidden w-full max-w-xs flex-1 lg:block" />
      <div className="flex items-center gap-4 text-right">
        <div className="hidden sm:block">
          <p className="text-sm font-semibold">商家经营看板</p>
          <p className="text-xs text-app-muted">
            {ready ? "数据来自 Analytics API" : "正在连接经营分析服务"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <NotificationCenter enabled={ready} />
          <UserBadge />
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
        <h1 className="text-xl font-semibold tracking-tight md:text-2xl">
          {periodLabel}经营，一眼看清
        </h1>
      </div>
      {controls ?? (
        <span className="w-fit rounded-lg border border-app-line bg-app-surface px-3 py-1.5 text-xs font-medium text-app-muted">
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
