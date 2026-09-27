"use client";
import Link from "next/link";
import { useState } from "react";
import { AssistantHistory } from "./history";
import { HistoryOverlay } from "./history-overlay";
import { AssistantConversation } from "./conversation";
import { AssistantComposer } from "./composer";
import { CopyWorkflow } from "./copy-workflow";
import { useAssistantWorkspace } from "./provider";
import type { AddInsight, AssistantArtifact } from "./artifact";
export function AssistantWorkspace({
  compact = false,
  onAdd,
  isAdded,
}: {
  compact?: boolean;
  onAdd?: AddInsight;
  isAdded?: Parameters<typeof AssistantArtifact>[0]["isAdded"];
}) {
  const { store, state, current } = useAssistantWorkspace();
  const [history, setHistory] = useState(false);
  return (
    <div className="assistant-workspace" data-compact={compact} data-history={history}>
      {!compact && (
        <div className="assistant-desktop-history">
          <AssistantHistory />
        </div>
      )}
      {history && <HistoryOverlay onClose={() => setHistory(false)} />}
      <section className="assistant-main" aria-label="经营助手对话">
        <div className="assistant-toolbar">
          <button type="button" aria-label="打开历史会话" onClick={() => setHistory(true)}>
            ☰
          </button>
          <span>{current?.title ?? "新对话"}</span>
          <button type="button" disabled={!state.ready} onClick={store.create}>
            ＋ 新对话
          </button>
          {!compact && <Link href="/">返回经营分析</Link>}
        </div>
        {current?.query && (
          <p className="assistant-context">
            当前分析：{current.query.dateRange.start} — {current.query.dateRange.end}
            <span>可直接说“换个时间”或继续追问</span>
          </p>
        )}
        <AssistantConversation onAdd={onAdd} isAdded={isAdded} />
        {state.error && state.ready && (
          <p className="assistant-notice" role="alert">
            {state.error}
          </p>
        )}
        {state.warning && (
          <p className="assistant-notice" role="status">
            {state.warning}
          </p>
        )}
        {state.runningId && state.runningId !== current?.id && (
          <button className="assistant-notice" onClick={() => store.select(state.runningId)}>
            另一个会话正在处理，点击查看
          </button>
        )}
        <CopyWorkflow />
        <AssistantComposer
          value={current?.draft ?? ""}
          onChange={store.setDraft}
          onSubmit={() => void store.submit()}
          onStop={store.stop}
          busy={Boolean(state.runningId) && state.runningId === current?.id}
          disabled={!state.ready || Boolean(state.runningId && state.runningId !== current?.id)}
        />
      </section>
    </div>
  );
}
