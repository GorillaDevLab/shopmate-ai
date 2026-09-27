"use client";
import Link from "next/link";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { DashboardInsightPreviewResponse } from "@shopmate/contracts";
import { AssistantWorkspace } from "./assistant/workspace";
import { useAssistantWorkspace } from "./assistant/provider";
import type { AddInsight } from "./assistant/artifact";
type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onInsightCreated?: AddInsight;
  isInsightAdded?: (preview: DashboardInsightPreviewResponse) => boolean;
};
export function DashboardAiAssistant({
  open,
  onOpenChange,
  onInsightCreated,
  isInsightAdded,
}: Props) {
  const { store, state } = useAssistantWorkspace();
  const [width, setWidth] = useState(520);
  const dialog = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const consumed = useRef<unknown>(null);
  useEffect(() => {
    const artifact = state.pendingArtifact;
    if (!artifact || !onInsightCreated || consumed.current === artifact) return;
    consumed.current = artifact;
    try {
      onInsightCreated(artifact.preview, artifact.view);
      store.markArtifactAdded(artifact.preview);
      store.clearArtifact();
    } catch (cause) {
      store.reportError(cause instanceof Error ? cause.message : "无法加入看板");
      onOpenChange(true);
      store.clearArtifact();
    }
  }, [state.pendingArtifact, onInsightCreated, store, onOpenChange]);
  useEffect(() => {
    if (!open) return;
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const element = dialog.current;
    if (typeof element?.show === "function") element.show();
    else element?.setAttribute("open", "");
    element?.querySelector<HTMLTextAreaElement>("textarea")?.focus();
    return () => {
      element?.close?.();
      opener.current?.focus();
    };
  }, [open]);
  return (
    <>
      <button
        className={`ai-assistant-pill ${open ? "is-hidden" : ""}`}
        aria-label="Ask AI"
        aria-hidden={open}
        tabIndex={open ? -1 : 0}
        onClick={() => onOpenChange(true)}
      >
        <span className="ai-assistant-orb" aria-hidden="true" />
        Ask AI
      </button>
      {open && (
        <dialog
          ref={dialog}
          className="assistant-drawer"
          style={{ "--assistant-width": `${width}px` } as CSSProperties}
          aria-labelledby="assistant-drawer-title"
          onCancel={(e) => {
            e.preventDefault();
            onOpenChange(false);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              onOpenChange(false);
            }
          }}
        >
          <div
            role="separator"
            aria-label="调整助手宽度"
            aria-orientation="vertical"
            aria-valuemin={380}
            aria-valuemax={900}
            aria-valuenow={width}
            tabIndex={0}
            className="assistant-resize"
            onKeyDown={(e) => {
              if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
                e.preventDefault();
                setWidth((w) =>
                  Math.max(380, Math.min(900, w + (e.key === "ArrowLeft" ? 40 : -40))),
                );
              }
            }}
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture(e.pointerId);
              e.preventDefault();
            }}
            onPointerMove={(e) => {
              if (e.currentTarget.hasPointerCapture(e.pointerId))
                setWidth(Math.max(380, Math.min(900, window.innerWidth - e.clientX - 12)));
            }}
            onPointerUp={(e) => {
              if (e.currentTarget.hasPointerCapture(e.pointerId))
                e.currentTarget.releasePointerCapture(e.pointerId);
            }}
          />
          <header className="assistant-drawer-header">
            <span className="ai-assistant-orb" aria-hidden="true" />
            <h2 id="assistant-drawer-title">AI 经营助手</h2>
            <button
              aria-label={width > 520 ? "恢复面板宽度" : "加宽聊天面板"}
              onClick={() => setWidth((w) => (w > 520 ? 520 : 820))}
            >
              ↔
            </button>
            <Link href="/chat" aria-label="打开完整聊天">
              ↗
            </Link>
            <button aria-label="关闭 AI 助手" onClick={() => onOpenChange(false)}>
              ›
            </button>
          </header>
          <AssistantWorkspace compact onAdd={onInsightCreated} isAdded={isInsightAdded} />
        </dialog>
      )}
    </>
  );
}
