"use client";

import type { AnalyticsOverviewResponse } from "@shopmate/contracts";
import Link from "next/link";

import { AppShell } from "../app-shell";
import { AppearanceAmbient } from "../appearance-controls";
import { DashboardRangeControls, type DashboardRange } from "../dashboard-range";
import { EXPLORE_HREF, renderCard, type CardContext } from "./analytics-cards";
import { EditBar, EditableSlot } from "./analytics-editor";
import { CHANNEL_CARDS } from "./analytics-layout";
import { formatShortDate, isEmptyOverview } from "./analytics-model";
import { SparkIcon } from "./analytics-panels";
import type { LayoutEditor } from "./use-analytics-layout";

export type OverviewState =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly data: AnalyticsOverviewResponse }
  | { readonly status: "error"; readonly authRequired: boolean; readonly message: string };

type Ask = (question: string) => void;

type Props = {
  readonly state: OverviewState;
  readonly refreshing: boolean;
  readonly range: DashboardRange;
  readonly latestDate: string;
  readonly onRangeChange: (range: DashboardRange) => void;
  readonly onRetry: () => void;
  readonly onAsk: Ask;
  readonly editor: LayoutEditor;
};

export function AnalyticsView({
  state,
  refreshing,
  range,
  latestDate,
  onRangeChange,
  onRetry,
  onAsk,
  editor,
}: Props) {
  const data = state.status === "ready" ? state.data : null;
  return (
    <AppShell active="analytics" notificationsEnabled={state.status === "ready"}>
      <AppearanceAmbient />
      <div
        className="analytics-page"
        id="main-content"
        aria-busy={state.status === "loading" || refreshing}
      >
        <AnalyticsHeader editor={editor} />
        {editor.editing && <EditBar editor={editor} />}
        <div className="analytics-filters">
          <DashboardRangeControls value={range} latestDate={latestDate} onChange={onRangeChange} />
          {data && (
            <p className="analytics-compare">
              对比上一周期：{formatShortDate(data.comparisonPeriod.startDate)}–
              {formatShortDate(data.comparisonPeriod.endDate)}
            </p>
          )}
        </div>
        <div className={refreshing ? "analytics-body is-refreshing" : "analytics-body"}>
          {(state.status === "loading" || (data && editor.loading)) && <LoadingState />}
          {state.status === "error" && <ErrorState state={state} onRetry={onRetry} />}
          {data &&
            !editor.loading &&
            (isEmptyOverview(data) ? (
              <EmptyState />
            ) : (
              <Overview data={data} onAsk={onAsk} editor={editor} />
            ))}
        </div>
      </div>
    </AppShell>
  );
}

function AnalyticsHeader({ editor }: { editor: LayoutEditor }) {
  return (
    <header className="analytics-header">
      <h1>经营分析</h1>
      <div className="analytics-header-actions">
        {editor.loadError && !editor.editing && (
          <p className="analytics-layout-error" role="status">
            布局读取失败，点击“编辑看板”重试
          </p>
        )}
        {!editor.editing && (
          <button
            type="button"
            className="btn-secondary"
            onClick={editor.startEdit}
            disabled={editor.loading}
          >
            编辑看板
          </button>
        )}
        <Link className="btn-primary" href={EXPLORE_HREF}>
          <SparkIcon size={15} />
          新建 AI 图表
        </Link>
      </div>
    </header>
  );
}

function Overview({
  data,
  onAsk,
  editor,
}: {
  data: AnalyticsOverviewResponse;
  onAsk: Ask;
  editor: LayoutEditor;
}) {
  const { cards } = editor.layout;
  const noChannelsNoteAt =
    data.channels.length > 0
      ? null
      : (CHANNEL_CARDS.find((id) => cards.some((card) => card.id === id)) ?? null);
  const context: CardContext = { data, onAsk, noChannelsNoteAt };
  return (
    <section className="analytics-grid" aria-label="经营图表">
      {cards.map((card, index) => {
        const content = renderCard(card, context);
        if (editor.editing) {
          return (
            <EditableSlot
              key={card.id}
              card={card}
              index={index}
              count={cards.length}
              editor={editor}
            >
              {content}
            </EditableSlot>
          );
        }
        if (content === null) return null;
        return (
          <div key={card.id} className={`analytics-slot span-${card.span}`}>
            {content}
          </div>
        );
      })}
    </section>
  );
}

function LoadingState() {
  return (
    <div className="analytics-state" role="status" aria-live="polite">
      <div className="analytics-skeleton" aria-hidden="true">
        {Array.from({ length: 4 }, (_, i) => (
          <span key={i} />
        ))}
      </div>
      <p>正在整理你的经营数据…</p>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="analytics-state" role="status">
      <h2>还没有经营数据</h2>
      <p>导入第一批商品并产生订单后，这里会自动生成经营分析。</p>
    </div>
  );
}

function ErrorState({
  state,
  onRetry,
}: {
  state: Extract<OverviewState, { status: "error" }>;
  onRetry: () => void;
}) {
  return (
    <div className="analytics-state" role="alert">
      <h2>数据暂时加载失败</h2>
      <p>{state.authRequired ? "登录已失效，请重新登录后查看经营数据。" : state.message}</p>
      <div className="analytics-state-actions">
        {state.authRequired && (
          <a className="btn-primary" href="/login">
            重新登录
          </a>
        )}
        <button type="button" className="btn-secondary" onClick={onRetry}>
          重新加载
        </button>
      </div>
    </div>
  );
}
