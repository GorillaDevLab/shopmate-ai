"use client";
import { useEffect, useRef } from "react";
import { AssistantHistory } from "./history";

export function HistoryOverlay({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const opener = document.activeElement;
    ref.current?.querySelector<HTMLButtonElement>("button")?.focus();
    return () => {
      if (opener instanceof HTMLElement) opener.focus();
    };
  }, []);
  return (
    <div
      ref={ref}
      className="assistant-history-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="选择历史会话"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          event.preventDefault();
          onClose();
        }
        if (event.key !== "Tab") return;
        const elements = Array.from(
          ref.current?.querySelectorAll<HTMLElement>(
            "button:not(:disabled),input,summary,[href]",
          ) ?? [],
        ).filter((el) => el.getClientRects().length > 0);
        const first = elements[0],
          last = elements[elements.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        }
        if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }}
    >
      <button className="assistant-history-dismiss" aria-label="关闭历史会话" onClick={onClose}>
        关闭
      </button>
      <AssistantHistory onSelect={onClose} />
    </div>
  );
}
