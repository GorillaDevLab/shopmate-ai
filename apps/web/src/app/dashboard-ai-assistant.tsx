"use client";

import Link from "next/link";
import { AssistantMarkdown } from "./assistant-markdown";
import {
  useEffect,
  useRef,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MutableRefObject,
  type RefObject,
} from "react";

import { type ChatMessage, useChatSession } from "./chat-session";
import { generateDashboardInsight } from "./dashboard-insight-api";
import type { DashboardInsightPreviewResponse } from "@shopmate/contracts";

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
};

export function DashboardAiAssistant({ open, onOpenChange, onInsightCreated }: AssistantProps) {
  const chat = useChatSession({
    resolveMessage: async (prompt) => {
      const kind = insightKind(prompt);
      if (!kind || !onInsightCreated) return undefined;
      const preview = await generateDashboardInsight(prompt, kind);
      onInsightCreated(preview);
      return {
        role: "assistant",
        content: "已加入看板草稿，可撤销或删除。保存后将在其他设备恢复。",
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
          {conversation && <Conversation messages={chat.messages} isSending={chat.isSending} />}
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

function Conversation({ messages, isSending }: { messages: ChatMessage[]; isSending: boolean }) {
  return (
    <div className="ai-assistant-conversation" aria-live="polite">
      {messages.map((message, index) => (
        <div key={`${message.role}-${index}`} className={`ai-message is-${message.role}`}>
          {message.role === "assistant" ? (
            <AssistantMarkdown content={message.content} />
          ) : (
            message.content
          )}
        </div>
      ))}
      {isSending && (
        <p className="ai-assistant-thinking" role="status">
          正在整理经营数据…
        </p>
      )}
    </div>
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
            onClick={() => chat.setInput(suggestion.prompt)}
          >
            {suggestion.label}
          </button>
        ))}
      </div>
      {chat.error && (
        <div className="ai-assistant-error" role="alert">
          <span>{chat.error}</span>
          <button type="button" onClick={() => void chat.retry()}>
            重试
          </button>
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
