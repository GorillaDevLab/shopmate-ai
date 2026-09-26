"use client";
import { useId, useLayoutEffect, useRef } from "react";
type Props = {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onStop: () => void;
  busy: boolean;
  disabled: boolean;
};
export function AssistantComposer({ value, onChange, onSubmit, onStop, busy, disabled }: Props) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);
  const id = useId();
  useLayoutEffect(() => {
    if (ref.current) {
      ref.current.style.height = "auto";
      ref.current.style.height = `${Math.min(180, Math.max(64, ref.current.scrollHeight))}px`;
    }
  }, [value]);
  return (
    <div className="assistant-compose">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!busy && !disabled && value.trim()) onSubmit();
        }}
      >
        <label className="sr-only" htmlFor={id}>
          消息
        </label>
        <textarea
          ref={ref}
          id={id}
          rows={2}
          maxLength={2000}
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          onCompositionStart={() => {
            composing.current = true;
          }}
          onCompositionEnd={() => {
            composing.current = false;
          }}
          onKeyDown={(e) => {
            if (
              e.key === "Enter" &&
              !e.shiftKey &&
              !e.nativeEvent.isComposing &&
              !composing.current &&
              e.keyCode !== 229
            ) {
              e.preventDefault();
              if (!busy && !disabled && value.trim()) onSubmit();
            }
          }}
          placeholder="问经营问题，或接着上一个回答追问…"
        />
        <div className="assistant-compose-footer">
          <span>DeepSeek · 经营助手</span>
          {busy ? (
            <button type="button" aria-label="停止生成" onClick={onStop}>
              ■
            </button>
          ) : (
            <button type="submit" aria-label="发送消息" disabled={disabled || !value.trim()}>
              ↑
            </button>
          )}
        </div>
      </form>
      <p className="assistant-compose-hint">
        Enter 发送，Shift + Enter 换行 · 数据以查询时的系统记录为准
      </p>
    </div>
  );
}
