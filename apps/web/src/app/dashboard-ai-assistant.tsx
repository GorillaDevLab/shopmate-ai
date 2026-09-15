"use client";

import Link from "next/link";
import { AssistantMarkdown } from "./assistant-markdown";
import { ChatPending } from "./chat-pending";
import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MutableRefObject,
  type RefObject,
} from "react";

import { type ChatMessage, useChatSession } from "./chat-session";
import { generateDashboardInsight } from "./dashboard-insight-api";
import type { DashboardInsightPreviewResponse } from "@shopmate/contracts";
import { DashboardPieChart } from "./dashboard-pie-chart";
import { DashboardReportCard } from "./dashboard-report-card";

const suggestions = [
  { label: "查看低库存", prompt: "最近哪些商品值得补货？" },
  { label: "分析热销商品", prompt: "请分析最近的热销商品" },
  { label: "总结销售趋势", prompt: "请总结最近的销售趋势" },
  { label: "生成销售饼图", prompt: "生成近 30 天各商品销售额占比饼图" },
] as const;

type AssistantProps = {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onInsightCreated?: (preview: DashboardInsightPreviewResponse) => void;
  readonly isInsightAdded?: (preview: DashboardInsightPreviewResponse) => boolean;
};

export function DashboardAiAssistant({
  open,
  onOpenChange,
  onInsightCreated,
  isInsightAdded,
}: AssistantProps) {
  const [added, setAdded] = useState(() => new Set<DashboardInsightPreviewResponse>());
  const chat = useChatSession({
    resolveMessage: async (prompt) => {
      const kind = insightKind(prompt);
      if (!kind || !onInsightCreated) return undefined;
      const preview = await generateDashboardInsight(prompt, kind);
      return {
        role: "assistant",
        content: "分析已完成。可以先查看结果，再决定是否加入看板。",
        insightPreview: preview,
      };
    },
  });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const conversation = chat.messages.length > 0 || chat.isSending || Boolean(chat.error);

  useAssistantDialog(open, dialogRef, inputRef, openerRef);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`ai-assistant-pill ${open ? "is-hidden" : ""}`}
        aria-label="Ask AI"
        aria-hidden={open}
        tabIndex={open ? -1 : 0}
        onClick={(event) => {
          openerRef.current = event.currentTarget;
          onOpenChange(true);
        }}
      >
        <span className="ai-assistant-orb" aria-hidden="true" />
        <span>Ask AI</span>
      </button>
      {open && (
        <dialog
          ref={dialogRef}
          className={`ai-assistant-dialog ${conversation ? "has-conversation" : ""}`}
          aria-labelledby="ai-assistant-title"
          onCancel={(event) => {
            event.preventDefault();
            onOpenChange(false);
          }}
          onKeyDown={(event) => closeOnEscape(event, onOpenChange)}
        >
          <AssistantHeader onClose={() => onOpenChange(false)} />
          {conversation && (
            <Conversation
              messages={chat.messages}
              isSending={chat.isSending}
              added={added}
              onAdd={onInsightCreated}
              onRememberAdded={(preview) => {
                setAdded((current) => {
                  const next = new Set(current);
                  next.add(preview);
                  return next;
                });
              }}
              isInsightAdded={isInsightAdded}
            />
          )}
          <AssistantComposer chat={chat} inputRef={inputRef} />
        </dialog>
      )}
    </>
  );
}

function AssistantHeader({ onClose }: { onClose: () => void }) {
  return (
    <header className="ai-assistant-header">
      <span className="ai-assistant-orb" aria-hidden="true" />
      <h2 id="ai-assistant-title">AI 经营助手</h2>
      <Link className="ai-assistant-icon-button" href="/chat" aria-label="打开完整聊天">
        ↗
      </Link>
      <button
        type="button"
        className="ai-assistant-icon-button"
        aria-label="关闭 AI 助手"
        onClick={onClose}
      >
        ×
      </button>
    </header>
  );
}

function Conversation({
  messages,
  isSending,
  added,
  onAdd,
  onRememberAdded,
  isInsightAdded,
}: {
  messages: ChatMessage[];
  isSending: boolean;
  added: ReadonlySet<DashboardInsightPreviewResponse>;
  onAdd?: (preview: DashboardInsightPreviewResponse) => void;
  onRememberAdded: (preview: DashboardInsightPreviewResponse) => void;
  isInsightAdded?: (preview: DashboardInsightPreviewResponse) => boolean;
}) {
  return (
    <div className="ai-assistant-conversation" aria-live="polite">
      {messages.map((message, index) => (
        <div key={`${message.role}-${index}`} className={`ai-message is-${message.role}`}>
          {message.role === "assistant" ? (
            <AssistantMarkdown content={message.content} />
          ) : (
            message.content
          )}
          {message.insightPreview && onAdd && (
            <InsightPreview
              preview={message.insightPreview}
              added={added}
              onAdd={onAdd}
              onRememberAdded={onRememberAdded}
              currentlyAdded={isInsightAdded?.(message.insightPreview)}
            />
          )}
        </div>
      ))}
      {isSending && <ChatPending />}
    </div>
  );
}

function InsightPreview({
  preview,
  added,
  onAdd,
  onRememberAdded,
  currentlyAdded,
}: {
  preview: DashboardInsightPreviewResponse;
  added: ReadonlySet<DashboardInsightPreviewResponse>;
  onAdd: (preview: DashboardInsightPreviewResponse) => void;
  onRememberAdded: (preview: DashboardInsightPreviewResponse) => void;
  currentlyAdded?: boolean;
}) {
  const [isAdded, setIsAdded] = useState(added.has(preview));
  const [error, setError] = useState("");
  const disabled = currentlyAdded ?? isAdded;
  const empty =
    preview.result.kind === "pie" && !preview.result.slices.some((slice) => slice.value > 0);
  const add = () => {
    if (disabled) return;
    try {
      onAdd(preview);
      onRememberAdded(preview);
      setIsAdded(true);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "暂时无法加入看板，分析结果已保留。");
    }
  };
  return (
    <section className="ai-insight-preview" aria-label="分析结果预览">
      {preview.result.kind === "pie" ? (
        <DashboardPieChart result={preview.result} />
      ) : (
        <DashboardReportCard result={preview.result} />
      )}
      {!empty && (
        <button type="button" disabled={disabled} onClick={add}>
          {disabled ? "已加入看板草稿" : "加入看板并查看"}
        </button>
      )}
      <p>
        {empty
          ? "请调整日期或筛选条件，当前结果不生成空白组件。"
          : "加入后可撤销或删除；点击看板上的“完成并保存”后才会保存。"}
      </p>
      {error && <p role="alert">{error}</p>}
    </section>
  );
}

type ChatSession = ReturnType<typeof useChatSession>;

function AssistantComposer({
  chat,
  inputRef,
}: {
  chat: ChatSession;
  inputRef: RefObject<HTMLTextAreaElement | null>;
}) {
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void chat.submit();
  };
  return (
    <div className="ai-assistant-compose-area">
      <div className="ai-assistant-suggestions" aria-label="经营问题建议">
        {suggestions.map((suggestion) => (
          <button
            key={suggestion.label}
            type="button"
            disabled={chat.isSending}
            onClick={() => chat.setInput(suggestion.prompt)}
          >
            {suggestion.label}
          </button>
        ))}
      </div>
      {chat.error && (
        <div className="ai-assistant-error" role="alert">
          <span>{chat.error}</span>
          {chat.retryable && (
            <button type="button" onClick={() => void chat.retry()}>
              重试
            </button>
          )}
        </div>
      )}
      <form className="ai-assistant-composer" onSubmit={submit}>
        <label className="sr-only" htmlFor="dashboard-ai-message">
          消息
        </label>
        <textarea
          ref={inputRef}
          id="dashboard-ai-message"
          value={chat.input}
          onChange={(event) => chat.setInput(event.target.value)}
          placeholder="询问库存、热销商品或销售趋势…"
          disabled={chat.isSending}
          rows={2}
        />
        <button
          type="submit"
          className="ai-assistant-send"
          aria-label="发送消息"
          disabled={chat.isSending || !chat.input.trim()}
        >
          ↑
        </button>
      </form>
    </div>
  );
}

function useAssistantDialog(
  open: boolean,
  dialogRef: RefObject<HTMLDialogElement | null>,
  inputRef: RefObject<HTMLTextAreaElement | null>,
  openerRef: MutableRefObject<HTMLElement | null>,
) {
  useEffect(() => {
    if (!open) return;
    if (document.activeElement instanceof HTMLElement && document.activeElement !== document.body) {
      openerRef.current = document.activeElement;
    }
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
    inputRef.current?.focus();
    return () => {
      if (typeof dialog.close === "function" && dialog.open) dialog.close();
      else dialog.removeAttribute("open");
      openerRef.current?.focus();
    };
  }, [dialogRef, inputRef, open, openerRef]);
}

function closeOnEscape(
  event: ReactKeyboardEvent<HTMLDialogElement>,
  onOpenChange: (open: boolean) => void,
) {
  if (event.key !== "Escape") return;
  event.preventDefault();
  onOpenChange(false);
}

function insightKind(prompt: string): "pie" | "report" | undefined {
  if (/饼图|占比图|圆饼/u.test(prompt)) return "pie";
  if (/生成.{0,8}报告|报告卡/u.test(prompt)) return "report";
  return undefined;
}
