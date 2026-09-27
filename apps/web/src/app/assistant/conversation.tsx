"use client";
import { useEffect, useRef, useState } from "react";
import type { WorkspaceMessage } from "@shopmate/contracts";
import { AssistantMarkdown } from "../assistant-markdown";
import { ActionProposalCard } from "./action-card";
import { AssistantArtifact, ProductCopyCard, type AddInsight } from "./artifact";
import { useAssistantWorkspace } from "./provider";
export function AssistantConversation({
  onAdd,
  isAdded,
}: {
  onAdd?: AddInsight;
  isAdded?: Parameters<typeof AssistantArtifact>[0]["isAdded"];
}) {
  const { state, current, store } = useAssistantWorkspace();
  const ref = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const [showLatest, setShowLatest] = useState(false);
  useEffect(() => {
    follow.current = true;
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [current?.id]);
  useEffect(() => {
    const viewport = ref.current;
    if (!viewport || !follow.current) return;
    const last = current?.messages.at(-1);
    const message = viewport.querySelector<HTMLElement>(".assistant-message:last-child");
    // A completed reply arrives as one record: reveal its beginning, not just its chart footer.
    if (last?.role === "assistant" && message) {
      viewport.scrollTop +=
        message.getBoundingClientRect().top - viewport.getBoundingClientRect().top;
    } else viewport.scrollTop = viewport.scrollHeight;
  }, [current?.messages, state.progress]);
  if (!state.ready)
    return (
      <div className="assistant-empty" role="status">
        <h2>{state.error ? "暂时无法打开会话" : "正在加载工作区"}</h2>
        <p>{state.error || "正在验证登录状态…"}</p>
        {state.error && <a href="/login">重新登录</a>}
      </div>
    );
  return (
    <div
      className="assistant-reading"
      ref={ref}
      onScroll={(e) => {
        const el = e.currentTarget;
        follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        setShowLatest(!follow.current);
      }}
    >
      {!current?.messages.length ? (
        <div className="assistant-empty">
          <span className="assistant-empty-orb" aria-hidden="true">
            ✦
          </span>
          <h2>今天，想了解哪一部分经营？</h2>
          <p>直接说你的问题。可以查数据、比较门店，也可以接着追问、生成图表。</p>
          <div className="assistant-starters">
            {[
              "最近经营怎么样？",
              "哪家门店表现最好？",
              "哪些商品需要关注库存？",
              "画出近30天各门店销售额",
            ].map((q) => (
              <button key={q} onClick={() => store.setDraft(q)}>
                {q}
                <span aria-hidden="true">↗</span>
              </button>
            ))}
          </div>
        </div>
      ) : (
        <div className="assistant-transcript" role="log" aria-label="聊天记录">
          {current.messages.map((message) => (
            <Message key={message.id} message={message} onAdd={onAdd} isAdded={isAdded} />
          ))}
        </div>
      )}
      {state.runningId === current?.id && (
        <div className="assistant-progress" role="status">
          <span className="assistant-progress-dot" />
          {state.progress}
        </div>
      )}
      {showLatest && (
        <button
          className="assistant-latest"
          onClick={() => {
            follow.current = true;
            setShowLatest(false);
            if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
          }}
        >
          ↓ 回到最新消息
        </button>
      )}
    </div>
  );
}
function Message({
  message,
  onAdd,
  isAdded,
}: {
  message: WorkspaceMessage;
  onAdd?: AddInsight;
  isAdded?: Parameters<typeof AssistantArtifact>[0]["isAdded"];
}) {
  const { store } = useAssistantWorkspace();
  const [feedback, setFeedback] = useState("");
  return (
    <article
      className={`assistant-message assistant-message-${message.role}`}
      data-status={message.status}
    >
      {message.role === "assistant" ? (
        <>
          <div className="assistant-message-author">
            <span aria-hidden="true">✦</span>经营助手
          </div>
          <AssistantMarkdown content={message.content} />
        </>
      ) : (
        <p>{message.content}</p>
      )}
      {message.insightPreview && (
        <AssistantArtifact
          preview={message.insightPreview}
          onAdd={onAdd}
          isAdded={isAdded}
          view={message.chartView}
          onViewChange={(view) => store.setChartView(message.id, view)}
        />
      )}
      {message.productCopy && <ProductCopyCard copy={message.productCopy} />}
      {message.actionProposals?.map((proposal) => (
        <ActionProposalCard
          key={proposal.token}
          proposal={proposal}
          outcome={message.actionOutcomes?.[proposal.token]}
          onOutcome={(outcome) => store.setActionOutcome(message.id, proposal.token, outcome)}
        />
      ))}
      {message.role === "assistant" && (
        <footer>
          <time dateTime={message.createdAt}>
            {new Date(message.createdAt).toLocaleTimeString("zh-CN", {
              hour: "2-digit",
              minute: "2-digit",
            })}{" "}
            ·{" "}
            {message.status === "complete"
              ? "本次查询结果"
              : message.status === "failed"
                ? "未完成"
                : "已停止"}
          </time>
          <button
            type="button"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(message.content);
                setFeedback("已复制");
              } catch {
                setFeedback("请选中文字复制");
              }
            }}
          >
            复制回复
          </button>
          <span role="status">{feedback}</span>
        </footer>
      )}
    </article>
  );
}
