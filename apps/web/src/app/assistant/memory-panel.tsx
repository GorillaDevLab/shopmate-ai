"use client";

import type { AssistantMemory } from "@shopmate/contracts";
import { useCallback, useEffect, useId, useRef, useState } from "react";

import { clearMemories, deleteMemory, listMemories } from "./memory-api";
import { useAssistantWorkspace } from "./provider";

type Pending =
  | { readonly kind: "memory"; readonly memory: AssistantMemory }
  | { readonly kind: "allMemories" }
  | { readonly kind: "allHistory" };

const CONFIRM_TEXT: Record<Pending["kind"], { title: string; body: string; action: string }> = {
  memory: { title: "删除这条记忆？", body: "AI 之后不会再参考它。", action: "删除" },
  allMemories: {
    title: "清空全部记忆？",
    body: "AI 会忘记你让它记住的所有偏好。",
    action: "清空记忆",
  },
  allHistory: {
    title: "删除全部对话记录？",
    body: "账号里和本机的所有对话都会被删除，其他设备也看不到了，无法恢复。",
    action: "删除全部对话",
  },
};

/** 查看和删除 AI 记住的偏好与对话记录；所有删除都要二次确认。 */
export function MemoryPanel() {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  // 只有打开面板时才挂载内容并读取记忆，进入页面不额外请求。
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (open) dialog.current?.showModal();
  }, [open]);
  return (
    <>
      <button type="button" className="assistant-memory-trigger" onClick={() => setOpen(true)}>
        记忆
      </button>
      <dialog
        ref={dialog}
        className="assistant-memory-dialog"
        aria-labelledby={titleId}
        onClose={() => setOpen(false)}
      >
        {open && <MemoryPanelBody titleId={titleId} onClose={() => dialog.current?.close()} />}
      </dialog>
    </>
  );
}

function MemoryPanelBody({ titleId, onClose }: { titleId: string; onClose: () => void }) {
  const { store } = useAssistantWorkspace();
  const { memories, status, message, reload, setMessage } = useMemories();
  const [pending, setPending] = useState<Pending | null>(null);

  const confirm = async () => {
    if (!pending) return;
    try {
      if (pending.kind === "memory") await deleteMemory(pending.memory.id);
      if (pending.kind === "allMemories") await clearMemories();
      if (pending.kind === "allHistory") await store.deleteAllHistory();
      setMessage(pending.kind === "allHistory" ? "已删除全部对话记录。" : "已删除。");
      await reload();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "删除失败，请稍后重试。");
    } finally {
      setPending(null);
    }
  };

  return (
    <div className="assistant-memory-body">
      <header>
        <h2 id={titleId}>AI 记忆</h2>
        <button type="button" aria-label="关闭记忆" onClick={onClose}>
          ✕
        </button>
      </header>
      <p className="assistant-memory-hint">
        你表达偏好或说“记住……”时，AI
        会记下来，之后的对话都会参考。记忆只用来理解你的习惯，不会当作经营数据。
      </p>
      {status === "loading" && <p role="status">正在读取…</p>}
      {status === "error" && (
        <p role="alert">
          {message}{" "}
          <button type="button" onClick={() => void reload()}>
            重试
          </button>
        </p>
      )}
      {status === "ready" && memories.length === 0 && (
        <p className="assistant-memory-empty">还没有记住任何偏好。</p>
      )}
      {memories.length > 0 && (
        <ul className="assistant-memory-list">
          {memories.map((memory) => (
            <li key={memory.id}>
              <span>{memory.content}</span>
              <button
                type="button"
                aria-label={`删除记忆：${memory.content}`}
                onClick={() => setPending({ kind: "memory", memory })}
              >
                删除
              </button>
            </li>
          ))}
        </ul>
      )}
      {status === "ready" && message && <p role="status">{message}</p>}
      {pending ? (
        <ConfirmStrip
          pending={pending}
          onConfirm={() => void confirm()}
          onCancel={() => setPending(null)}
        />
      ) : (
        <footer>
          <button
            type="button"
            disabled={memories.length === 0}
            onClick={() => setPending({ kind: "allMemories" })}
          >
            清空全部记忆
          </button>
          <button
            type="button"
            className="assistant-memory-danger"
            onClick={() => setPending({ kind: "allHistory" })}
          >
            删除全部对话记录
          </button>
        </footer>
      )}
    </div>
  );
}

function ConfirmStrip({
  pending,
  onConfirm,
  onCancel,
}: {
  pending: Pending;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const text = CONFIRM_TEXT[pending.kind];
  return (
    <div className="assistant-memory-confirm" role="alertdialog" aria-label={text.title}>
      <strong>{text.title}</strong>
      <p>{pending.kind === "memory" ? `「${pending.memory.content}」${text.body}` : text.body}</p>
      <div>
        <button type="button" onClick={onCancel}>
          取消
        </button>
        <button type="button" className="assistant-memory-danger" onClick={onConfirm}>
          {text.action}
        </button>
      </div>
    </div>
  );
}

function useMemories() {
  const [memories, setMemories] = useState<AssistantMemory[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [message, setMessage] = useState("");
  const reload = useCallback(async () => {
    try {
      setMemories(await listMemories());
      setStatus("ready");
    } catch (error) {
      setStatus("error");
      setMessage(error instanceof Error ? error.message : "读取失败，请稍后重试。");
    }
  }, []);
  useEffect(() => {
    let alive = true;
    listMemories().then(
      (items) => {
        if (!alive) return;
        setMemories(items);
        setStatus("ready");
      },
      (error: unknown) => {
        if (!alive) return;
        setStatus("error");
        setMessage(error instanceof Error ? error.message : "读取失败，请稍后重试。");
      },
    );
    return () => {
      alive = false;
    };
  }, []);
  return { memories, status, message, reload, setMessage };
}
