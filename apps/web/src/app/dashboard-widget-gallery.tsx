"use client";

import {
  DASHBOARD_COMPONENT_REGISTRY,
  type DashboardInsightPreviewResponse,
  type DashboardLayoutComponent,
} from "@shopmate/contracts";
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";

import { generateDashboardInsight } from "./dashboard-insight-api";
import { DashboardComparisonChart } from "./dashboard-comparison-chart";
import { DashboardReportCard } from "./dashboard-report-card";

type StandardComponent = Exclude<DashboardLayoutComponent, "pieChart" | "report">;

type DashboardWidgetGalleryProps = {
  open: boolean;
  cardCount: number;
  onAdd: (component: StandardComponent) => void;
  onAddInsight?: (
    component: "pieChart" | "report",
    preview: DashboardInsightPreviewResponse,
  ) => void;
  onClose: () => void;
};

const components = Object.keys(DASHBOARD_COMPONENT_REGISTRY) as DashboardLayoutComponent[];

const previewCopy: Record<DashboardLayoutComponent, string> = {
  metric: "突出显示销售额、订单、销量或客单价。",
  salesTrend: "查看当前统计周期的每日销售变化。",
  inventoryAlerts: "集中查看库存偏低、需要补货的商品。",
  hotProducts: "展示当前周期表现最好的商品。",
  pieChart: "用自然语言生成可保存、可刷新的经营占比图。",
  report: "让 AI 将经营数据整理成结构化报告。",
};

export function DashboardWidgetGallery({
  open,
  cardCount,
  onAdd,
  onAddInsight,
  onClose,
}: DashboardWidgetGalleryProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [selected, setSelected] = useState<DashboardLayoutComponent>("metric");
  const [question, setQuestion] = useState("");
  const [preview, setPreview] = useState<DashboardInsightPreviewResponse>();
  const [generating, setGenerating] = useState(false);
  const [generationError, setGenerationError] = useState<string>();
  useGalleryDialog(open, dialogRef);
  if (!open) return null;

  const isFull = cardCount >= 24;
  const label = DASHBOARD_COMPONENT_REGISTRY[selected].label;
  return (
    <dialog
      ref={dialogRef}
      className="widget-gallery"
      aria-labelledby="widget-gallery-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onKeyDown={(event) => handleEscape(event, onClose)}
    >
      <div className="widget-gallery-shell">
        <GalleryHeader onClose={onClose} />
        <div className="widget-gallery-body">
          <nav aria-label="可添加组件">
            {components.map((component) => (
              <button
                key={component}
                type="button"
                aria-pressed={selected === component}
                onClick={() => setSelected(component)}
              >
                <WidgetMark component={component} />
                <span>{DASHBOARD_COMPONENT_REGISTRY[component].label}</span>
              </button>
            ))}
          </nav>
          <section className="widget-gallery-preview" aria-live="polite">
            <div className="widget-gallery-preview-card">
              {preview && isInsightComponent(selected) ? (
                <InsightPreview preview={preview} />
              ) : (
                <WidgetPreview component={selected} />
              )}
            </div>
            <div>
              <p className="widget-gallery-kicker">预览</p>
              <h3>{label}</h3>
              <p>{previewCopy[selected]}</p>
            </div>
            {isFull && <p className="widget-gallery-limit">看板最多包含 24 张卡片</p>}
            {isInsightComponent(selected) ? (
              <InsightGenerator
                component={selected}
                question={question}
                preview={preview}
                generating={generating}
                error={generationError}
                isFull={isFull}
                onQuestionChange={setQuestion}
                onGenerate={async () => {
                  setGenerating(true);
                  setGenerationError(undefined);
                  try {
                    setPreview(
                      await generateDashboardInsight(
                        question,
                        selected === "pieChart" ? "pie" : "report",
                      ),
                    );
                  } catch (error: unknown) {
                    setGenerationError(error instanceof Error ? error.message : "生成失败，请重试");
                  } finally {
                    setGenerating(false);
                  }
                }}
                onAdd={() => preview && onAddInsight?.(selected, preview)}
              />
            ) : (
              <button type="button" disabled={isFull} onClick={() => onAdd(selected)}>
                添加到看板
              </button>
            )}
          </section>
        </div>
      </div>
    </dialog>
  );
}

function GalleryHeader({ onClose }: { onClose: () => void }) {
  return (
    <header>
      <div>
        <p className="widget-gallery-kicker">组件库</p>
        <h2 id="widget-gallery-title">添加经营组件</h2>
      </div>
      <button type="button" aria-label="关闭组件库" onClick={onClose}>
        <span aria-hidden="true">×</span>
      </button>
    </header>
  );
}

function WidgetMark({ component }: { component: DashboardLayoutComponent }) {
  const paths: Record<DashboardLayoutComponent, string> = {
    metric: "M5 15V9m5 6V5m5 10v-3",
    salesTrend: "m4 14 4-5 4 3 5-7",
    inventoryAlerts: "M5 7h10v9H5zM7 4h6v3",
    hotProducts:
      "M10 3c3 3 4 5 2 7 2-1 4 1 3 4-1 3-3 4-5 4s-4-1-5-4c-1-3 1-6 3-8 0 2 1 3 2 4 1-2 1-4 0-7Z",
    pieChart: "M10 3v7h7a7 7 0 1 1-7-7Zm2 0a5 5 0 0 1 5 5h-5Z",
    report: "M5 3h10v14H5zM8 7h4m-4 3h5m-5 3h3",
  };
  return (
    <span className="widget-gallery-mark" aria-hidden="true">
      <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6">
        <path d={paths[component]} strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  );
}

function WidgetPreview({ component }: { component: DashboardLayoutComponent }) {
  if (component === "metric") return <strong>¥24,860</strong>;
  if (component === "salesTrend") return <span className="widget-preview-line" />;
  if (component === "inventoryAlerts") return <span>4 项需要关注</span>;
  if (component === "pieChart") return <span>输入问题后生成饼图预览</span>;
  if (component === "report") return <span>输入问题后生成报告预览</span>;
  return <span>本期热销排行</span>;
}

function InsightGenerator(props: {
  component: "pieChart" | "report";
  question: string;
  preview?: DashboardInsightPreviewResponse;
  generating: boolean;
  error?: string;
  isFull: boolean;
  onQuestionChange: (value: string) => void;
  onGenerate: () => Promise<void>;
  onAdd: () => void;
}) {
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void props.onGenerate();
  };
  return (
    <form className="widget-insight-form" onSubmit={submit}>
      <label htmlFor="widget-insight-question">想分析什么？</label>
      <textarea
        id="widget-insight-question"
        value={props.question}
        onChange={(event) => props.onQuestionChange(event.target.value)}
        placeholder={
          props.component === "pieChart"
            ? "例如：按商品生成近 30 天销售额占比"
            : "例如：总结近 90 天经营表现"
        }
        maxLength={2000}
        rows={3}
      />
      {props.error && (
        <p className="widget-gallery-limit" role="alert">
          {props.error}
        </p>
      )}
      <div className="widget-insight-actions">
        <button type="submit" disabled={props.generating || !props.question.trim()}>
          {props.generating ? "生成中…" : "生成预览"}
        </button>
        <button type="button" disabled={props.isFull || !props.preview} onClick={props.onAdd}>
          添加到看板
        </button>
      </div>
    </form>
  );
}

function InsightPreview({ preview }: { preview: DashboardInsightPreviewResponse }) {
  if (preview.result.kind === "pie")
    return (
      <DashboardComparisonChart
        key={JSON.stringify(preview.query)}
        result={preview.result}
        allowDonut={preview.query.metric !== "averageOrderValue"}
        initialView={
          preview.query.groupBy === "store" || preview.query.groupBy === "platform"
            ? "bar"
            : "donut"
        }
      />
    );
  return <DashboardReportCard result={preview.result} />;
}

function isInsightComponent(
  component: DashboardLayoutComponent,
): component is "pieChart" | "report" {
  return component === "pieChart" || component === "report";
}

function useGalleryDialog(open: boolean, dialogRef: React.RefObject<HTMLDialogElement | null>) {
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog || !open) return;
    if (typeof dialog.showModal === "function" && !dialog.open) dialog.showModal();
    else dialog.setAttribute("open", "");
    return () => {
      if (typeof dialog.close === "function" && dialog.open) dialog.close();
      else dialog.removeAttribute("open");
    };
  }, [dialogRef, open]);
}

function handleEscape(event: KeyboardEvent<HTMLDialogElement>, onClose: () => void) {
  if (event.key !== "Escape") return;
  event.preventDefault();
  onClose();
}
