"use client";

import {
  isAnalyticsAiCard,
  type AnalyticsCardSpan,
  type AnalyticsLayoutCard,
} from "@shopmate/contracts";
import { useId, useRef, useState, type DragEvent, type ReactNode, type RefObject } from "react";

import {
  CARD_LABELS,
  cardLabel,
  dropCard,
  hiddenCards,
  moveCard,
  removeCard,
  resetLayout,
  setSpan,
  showCard,
} from "./analytics-layout";
import type { LayoutEditor } from "./use-analytics-layout";

const SPANS: readonly AnalyticsCardSpan[] = [1, 2, 3];

type SlotProps = {
  card: AnalyticsLayoutCard;
  index: number;
  count: number;
  editor: LayoutEditor;
  children: ReactNode;
};

/** 编辑模式下每张卡片外包一层工具条：拖动或上下移动排序、改宽度、隐藏或删除。 */
export function EditableSlot({ card, index, count, editor, children }: SlotProps) {
  const [over, setOver] = useState(false);
  const { id, span } = card;
  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setOver(false);
    const dragged = event.dataTransfer.getData("text/plain");
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
      <SlotToolbar card={card} index={index} count={count} editor={editor} />
      {children ?? <p className="slot-placeholder">当前时段没有可显示的内容</p>}
    </div>
  );
}

function SlotToolbar({ card, index, count, editor }: Omit<SlotProps, "children">) {
  const confirm = useRef<HTMLDialogElement>(null);
  const label = cardLabel(card);
  const { id, span } = card;
  const ai = isAnalyticsAiCard(card);
  return (
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
        aria-label={`${ai ? "删除" : "隐藏"}${label}`}
        onClick={() =>
          ai ? confirm.current?.showModal() : editor.update((l) => removeCard(l, id))
        }
      >
        {ai ? "删除" : "隐藏"}
      </button>
      {ai && (
        <ConfirmDialog
          dialog={confirm}
          title={`删除「${label}」？`}
          body="这张 AI 图表会从经营分析移除，点“保存布局”后生效，之后需要在 AI 图表探索里重新生成。"
          confirmLabel="删除"
          onConfirm={() => editor.update((l) => removeCard(l, id))}
        />
      )}
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
      <ConfirmDialog
        dialog={confirmDialog}
        title="恢复默认布局？"
        body="内置卡片的顺序、宽度和隐藏设置会回到默认状态，已保存的 AI 图表保留在末尾。保存之前你仍可以取消。"
        confirmLabel="恢复默认"
        onConfirm={() => editor.update(resetLayout)}
      />
    </section>
  );
}

/** 会丢掉当前设置的操作都先二次确认；确认只改草稿，仍需“保存布局”才生效。 */
function ConfirmDialog({
  dialog,
  title,
  body,
  confirmLabel,
  onConfirm,
}: {
  dialog: RefObject<HTMLDialogElement | null>;
  title: string;
  body: string;
  confirmLabel: string;
  onConfirm: () => void;
}) {
  const titleId = useId();
  return (
    <dialog ref={dialog} className="analytics-dialog" aria-labelledby={titleId}>
      <h2 id={titleId}>{title}</h2>
      <p>{body}</p>
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
          {confirmLabel}
        </button>
      </div>
    </dialog>
  );
}
