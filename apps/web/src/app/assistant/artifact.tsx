"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import type {
  DashboardInsightPreviewResponse,
  DashboardChartView,
  ProductCopyOutput,
} from "@shopmate/contracts";
import {
  DashboardInsightPresentation,
  recommendInsightView,
} from "../dashboard-insight-presentation";
import { useAssistantWorkspace } from "./provider";
export type AddInsight = (
  preview: DashboardInsightPreviewResponse,
  view?: DashboardChartView,
) => void;
export function AssistantArtifact({
  preview,
  onAdd,
  isAdded,
  view: chosenView,
  onViewChange,
}: {
  preview: DashboardInsightPreviewResponse;
  onAdd?: AddInsight;
  isAdded?: (preview: DashboardInsightPreviewResponse) => boolean;
  view?: DashboardChartView;
  onViewChange?: (view: DashboardChartView) => void;
}) {
  const { store } = useAssistantWorkspace();
  const router = useRouter();
  const [localView, setLocalView] = useState<DashboardChartView>(
    () => recommendInsightView(preview.result, preview.query.visualization).view,
  );
  const view = chosenView ?? localView;
  const setView = (next: DashboardChartView) => {
    setLocalView(next);
    onViewChange?.(next);
  };
  const [error, setError] = useState("");
  const added = isAdded ? isAdded(preview) : store.isArtifactAdded(preview);
  const empty = preview.result.kind === "pie" && !preview.result.slices.some((s) => s.value > 0);
  const add = () => {
    try {
      if (onAdd) {
        onAdd(preview, view);
        store.markArtifactAdded(preview);
      } else {
        store.stageArtifact(preview, view);
        router.push("/");
      }
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "无法加入看板，结果已保留。");
    }
  };
  return (
    <section className="assistant-artifact" aria-label="分析结果预览">
      <DashboardInsightPresentation
        result={preview.result}
        view={view}
        onViewChange={setView}
        allowDonut={preview.query.metric !== "averageOrderValue"}
      />
      {!empty && (
        <button className="assistant-primary" disabled={added} onClick={add}>
          {added ? "已加入看板草稿" : "加入看板并查看"}
        </button>
      )}
      <p>
        {empty
          ? "当前没有可展示数据，请调整日期或筛选条件。"
          : "加入后可撤销；在看板点击“完成并保存”后才会保存。"}
      </p>
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
export function ProductCopyCard({ copy }: { copy: ProductCopyOutput }) {
  const [feedback, setFeedback] = useState("");
  const text = [copy.title, copy.body, copy.tags.map((t) => `#${t}`).join(" ")].join("\n\n");
  return (
    <article className="assistant-copy">
      <h3>{copy.title}</h3>
      <p>{copy.body}</p>
      <p>{copy.tags.map((t) => `#${t}`).join(" ")}</p>
      <button
        type="button"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(text);
            setFeedback("文案已复制");
          } catch {
            setFeedback("此浏览器不支持复制，请长按或选中文字复制。");
          }
        }}
      >
        复制文案
      </button>
      <span role="status">{feedback}</span>
    </article>
  );
}
