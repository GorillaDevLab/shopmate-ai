"use client";

import {
  DEFAULT_ANALYTICS_LAYOUT,
  type AnalyticsCardId,
  type AnalyticsCardSpan,
} from "@shopmate/contracts";
import { useRef, useState, type DragEvent, type ReactNode, type RefObject } from "react";

import {
  CARD_LABELS,
  dropCard,
  hiddenCards,
  hideCard,
  moveCard,
  setSpan,
  showCard,
} from "./analytics-layout";
import type { LayoutEditor } from "./use-analytics-layout";

const SPANS: readonly AnalyticsCardSpan[] = [1, 2, 3];

/** 编辑模式下每张卡片外包一层工具条：拖动或上下移动排序、改宽度、隐藏。 */
export function EditableSlot({
  id,
  span,
  index,
  count,
  editor,
  children,
}: {
  id: AnalyticsCardId;
  span: AnalyticsCardSpan;
  index: number;
  count: number;
  editor: LayoutEditor;
  children: ReactNode;
}) {
  const [over, setOver] = useState(false);
  const label = CARD_LABELS[id];
  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setOver(false);
    const dragged = event.dataTransfer.getData("text/plain") as AnalyticsCardId;
    if (dragged) editor.update((layout) => dropCard(layout, dragged, id));
  };
  return (
    <div
      className={`analytics-slot span-${span} is-editing${over ? " is-drop-target" : ""}`}
      draggable
      onDragStart={(event) => event.dataTransfer.setData("text/plain", id)}
      onDragOver={(event) => {
        event.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
    >
      <div className="slot-toolbar" role="group" aria-label={`${label}：布局`}>
        <span className="slot-handle" aria-hidden="true">
          ⠿
        </span>
        <span className="slot-name">{label}</span>
        <button
          type="button"
          aria-label={`${label}上移`}
          disabled={index === 0}
          onClick={() => editor.update((l) => moveCard(l, id, -1))}
        >
          ↑
        </button>
        <button
          type="button"
          aria-label={`${label}下移`}
          disabled={index === count - 1}
          onClick={() => editor.update((l) => moveCard(l, id, 1))}
        >
          ↓
        </button>
        <span className="slot-spans" role="group" aria-label={`${label}宽度`}>
          {SPANS.map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={span === value}
              onClick={() => editor.update((l) => setSpan(l, id, value))}
            >
              {value} 列
            </button>
          ))}
        </span>
        <button
          type="button"
          aria-label={`隐藏${label}`}
          onClick={() => editor.update((l) => hideCard(l, id))}
        >
          隐藏
        </button>
      </div>
      {children ?? <p className="slot-placeholder">当前时段没有可显示的内容</p>}
    </div>
  );
}

export function EditBar({ editor }: { editor: LayoutEditor }) {
  const confirmDialog = useRef<HTMLDialogElement>(null);
  const hidden = hiddenCards(editor.layout);
  return (
    <section className="analytics-card edit-bar" aria-label="编辑看板">
      <div className="edit-bar-row">
        <p className="edit-bar-hint">拖动卡片或用 ↑ ↓ 调整顺序，选择宽度，不需要的卡片可以隐藏。</p>
        <div className="edit-bar-actions">
          <button
            type="button"
            className="btn-secondary"
            onClick={() => confirmDialog.current?.showModal()}
          >
            恢复默认
          </button>
          <button
            type="button"
            className="btn-secondary"
            onClick={editor.cancel}
            disabled={editor.saving}
          >
            取消
          </button>
          <button
            type="button"
            className="btn-primary"
            onClick={() => void editor.save()}
            disabled={editor.saving}
          >
            {editor.saving ? "保存中…" : "保存布局"}
          </button>
        </div>
      </div>
      {hidden.length > 0 && (
        <div className="edit-bar-hidden" role="group" aria-label="已隐藏的卡片">
          <span className="muted">已隐藏：</span>
          {hidden.map((id) => (
            <button
              key={id}
              type="button"
              className="btn-secondary"
              onClick={() => editor.update((l) => showCard(l, id))}
            >
              + {CARD_LABELS[id]}
            </button>
          ))}
        </div>
      )}
      {editor.error && (
        <p className="explore-inline-error" role="alert">
          {editor.error}
        </p>
      )}
      <ResetDialog
        dialog={confirmDialog}
        onConfirm={() => editor.update(() => DEFAULT_ANALYTICS_LAYOUT)}
      />
    </section>
  );
}

/** 恢复默认会丢掉当前的排序与隐藏设置，需要二次确认；确认后仍需点“保存布局”才生效。 */
function ResetDialog({
  dialog,
  onConfirm,
}: {
  dialog: RefObject<HTMLDialogElement | null>;
  onConfirm: () => void;
}) {
  return (
    <dialog ref={dialog} className="analytics-dialog" aria-labelledby="reset-layout-title">
      <h2 id="reset-layout-title">恢复默认布局？</h2>
      <p>卡片顺序、宽度和隐藏设置会回到默认状态。保存之前你仍可以取消。</p>
      <div className="analytics-state-actions">
        <button type="button" className="btn-secondary" onClick={() => dialog.current?.close()}>
          取消
        </button>
        <button
          type="button"
          className="btn-primary"
          onClick={() => {
            onConfirm();
            dialog.current?.close();
          }}
        >
          恢复默认
        </button>
      </div>
    </dialog>
  );
}
