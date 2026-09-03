"use client";

import type { MonitoringRulePreviewResponse, MonitoringRuleView } from "@shopmate/contracts";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";

import {
  createMonitoringRule,
  deleteMonitoringRule,
  listMonitoringRules,
  previewMonitoringRule,
  runMonitoringRule,
  updateMonitoringRuleStatus,
} from "./monitoring-api";

interface MonitoringRuleManagerProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}

type ViewState = "loading" | "ready" | "error";

export function MonitoringRuleManager({ open, onOpenChange }: MonitoringRuleManagerProps) {
  const [rules, setRules] = useState<MonitoringRuleView[]>([]);
  const [viewState, setViewState] = useState<ViewState>("loading");
  const [question, setQuestion] = useState("");
  const [preview, setPreview] = useState<MonitoringRulePreviewResponse | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<MonitoringRuleView | null>(null);
  const questionRef = useRef<HTMLInputElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  const loadRules = useCallback(async () => {
    try {
      setRules((await listMonitoringRules()).items);
      setViewState("ready");
    } catch (caught) {
      setError(errorMessage(caught));
      setViewState("error");
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    let current = true;
    void listMonitoringRules()
      .then(({ items }) => {
        if (!current) return;
        setRules(items);
        setViewState("ready");
      })
      .catch((caught: unknown) => {
        if (!current) return;
        setError(errorMessage(caught));
        setViewState("error");
      });
    return () => {
      current = false;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    restoreFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusFrame = requestAnimationFrame(() => questionRef.current?.focus());
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      onOpenChange(false);
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      cancelAnimationFrame(focusFrame);
      document.removeEventListener("keydown", closeOnEscape);
      restoreFocusRef.current?.focus();
    };
  }, [onOpenChange, open]);

  if (!open) return null;

  async function submitPreview(event: FormEvent) {
    event.preventDefault();
    setPending("preview");
    setError("");
    try {
      setPreview(await previewMonitoringRule(question));
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setPending(null);
    }
  }

  async function confirmCreate() {
    if (!preview) return;
    setPending("create");
    try {
      const created = await createMonitoringRule({
        name: preview.suggestedName,
        definition: preview.definition,
      });
      setRules((current) => [created.rule, ...current]);
      setPreview(null);
      setQuestion("");
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setPending(null);
    }
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    const target = deleteTarget;
    setPending(`delete:${target.id}`);
    try {
      await deleteMonitoringRule(target.id);
      setRules((current) => current.filter((rule) => rule.id !== target.id));
      setDeleteTarget(null);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setPending(null);
    }
  }

  return (
    <div
      className="monitoring-overlay"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onOpenChange(false);
      }}
    >
      <section
        className="monitoring-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="monitoring-title"
      >
        <header className="monitoring-sheet-header">
          <div>
            <span className="monitoring-eyebrow">自动关注重要变化</span>
            <h2 id="monitoring-title">经营监听</h2>
          </div>
          <button
            type="button"
            className="icon-button"
            aria-label="关闭经营监听"
            onClick={() => onOpenChange(false)}
          >
            ×
          </button>
        </header>

        <form className="monitoring-composer" onSubmit={submitPreview}>
          <label htmlFor="monitoring-question">监听内容</label>
          <div className="monitoring-input-row">
            <input
              ref={questionRef}
              id="monitoring-question"
              value={question}
              maxLength={2000}
              onChange={(event) => setQuestion(event.target.value)}
              placeholder="例如：库存低于 5 件时提醒我"
            />
            <button type="submit" disabled={pending !== null || !question.trim()}>
              {pending === "preview" ? "理解中…" : "生成预览"}
            </button>
          </div>
          <p>AI 只能使用你店铺内的销售与库存数据，不会执行自由 SQL。</p>
        </form>

        {error && (
          <div className="monitoring-error" role="alert">
            {error}
          </div>
        )}
        {preview && (
          <RulePreview
            preview={preview}
            pending={pending === "create"}
            onConfirm={() => void confirmCreate()}
            onCancel={() => setPreview(null)}
          />
        )}

        <div className="monitoring-list-header">
          <h3>我的规则</h3>
          <span>{rules.filter((rule) => rule.status === "ACTIVE").length}/10 条启用上限</span>
        </div>
        <RuleList
          state={viewState}
          rules={rules}
          pending={pending}
          onRetry={() => {
            setViewState("loading");
            void loadRules();
          }}
          onToggle={async (rule) => {
            setPending(`toggle:${rule.id}`);
            try {
              const next = rule.status === "ACTIVE" ? "INACTIVE" : "ACTIVE";
              const updated = await updateMonitoringRuleStatus(rule.id, next);
              setRules((current) =>
                current.map((item) => (item.id === rule.id ? updated.rule : item)),
              );
            } catch (caught) {
              setError(errorMessage(caught));
            } finally {
              setPending(null);
            }
          }}
          onRun={async (rule) => {
            setPending(`run:${rule.id}`);
            try {
              await runMonitoringRule(rule.id);
              await loadRules();
            } catch (caught) {
              setError(errorMessage(caught));
            } finally {
              setPending(null);
            }
          }}
          onDelete={setDeleteTarget}
        />
      </section>
      {deleteTarget && (
        <DeleteConfirmation
          rule={deleteTarget}
          pending={pending === `delete:${deleteTarget.id}`}
          onCancel={() => setDeleteTarget(null)}
          onConfirm={() => void confirmDelete()}
        />
      )}
    </div>
  );
}

function RulePreview({
  preview,
  pending,
  onConfirm,
  onCancel,
}: {
  readonly preview: MonitoringRulePreviewResponse;
  readonly pending: boolean;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}) {
  return (
    <section className="monitoring-preview" aria-label="规则预览">
      <div>
        <span>AI 理解为</span>
        <h3>{preview.suggestedName}</h3>
        <p>{describeDefinition(preview.definition)}</p>
      </div>
      <strong className={preview.evaluation.matched ? "is-warning" : ""}>
        当前有 {preview.evaluation.matches.length} 项命中
      </strong>
      {preview.evaluation.matches[0] && (
        <p className="monitoring-preview-match">{preview.evaluation.matches[0].message}</p>
      )}
      <div className="monitoring-actions">
        <button type="button" className="secondary-button" onClick={onCancel}>
          重新描述
        </button>
        <button type="button" onClick={onConfirm} disabled={pending}>
          {pending ? "创建中…" : "确认创建"}
        </button>
      </div>
    </section>
  );
}

interface RuleListProps {
  readonly state: ViewState;
  readonly rules: MonitoringRuleView[];
  readonly pending: string | null;
  readonly onRetry: () => void;
  readonly onToggle: (rule: MonitoringRuleView) => Promise<void>;
  readonly onRun: (rule: MonitoringRuleView) => Promise<void>;
  readonly onDelete: (rule: MonitoringRuleView) => void;
}

function RuleList({ state, rules, pending, onRetry, onToggle, onRun, onDelete }: RuleListProps) {
  if (state === "loading")
    return (
      <div className="monitoring-state" role="status">
        正在读取监听规则…
      </div>
    );
  if (state === "error")
    return (
      <div className="monitoring-state" role="alert">
        规则加载失败。
        <button type="button" onClick={onRetry}>
          重试
        </button>
      </div>
    );
  if (rules.length === 0)
    return (
      <div className="monitoring-state">
        <strong>还没有监听规则</strong>
        <p>用一句话告诉 AI 你关心什么。</p>
      </div>
    );
  return (
    <ul className="monitoring-rule-list">
      {rules.map((rule) => (
        <li key={rule.id}>
          <div className="monitoring-rule-copy">
            <div>
              <span className={`status-dot ${rule.status === "ACTIVE" ? "active" : ""}`} />{" "}
              <strong>{rule.name}</strong>
            </div>
            <p>{describeDefinition(rule.definition)}</p>
            {rule.lastErrorMessage && <small role="alert">{rule.lastErrorMessage}</small>}
          </div>
          <div className="monitoring-rule-actions">
            <button type="button" disabled={pending !== null} onClick={() => void onRun(rule)}>
              检查
            </button>
            <button type="button" disabled={pending !== null} onClick={() => void onToggle(rule)}>
              {rule.status === "ACTIVE" ? "暂停" : "启用"}
            </button>
            <button
              type="button"
              className="danger-text"
              aria-label={`删除${rule.name}`}
              onClick={() => onDelete(rule)}
            >
              删除
            </button>
          </div>
        </li>
      ))}
    </ul>
  );
}

function DeleteConfirmation({
  rule,
  pending,
  onCancel,
  onConfirm,
}: {
  readonly rule: MonitoringRuleView;
  readonly pending: boolean;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}) {
  return (
    <div className="confirmation-backdrop">
      <section
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="delete-rule-title"
        className="confirmation-dialog"
      >
        <h3 id="delete-rule-title">删除监听规则</h3>
        <p>“{rule.name}”删除后将停止检查，已有通知仍会保留。</p>
        <div className="monitoring-actions">
          <button type="button" className="secondary-button" onClick={onCancel}>
            取消
          </button>
          <button type="button" className="danger-button" disabled={pending} onClick={onConfirm}>
            {pending ? "删除中…" : "确认删除"}
          </button>
        </div>
      </section>
    </div>
  );
}

function describeDefinition(definition: MonitoringRuleView["definition"]): string {
  const frequency = definition.frequency === "daily" ? "每天" : "每周";
  if (definition.kind === "inventoryThreshold")
    return `${frequency}检查库存，低于 ${definition.threshold} 件时提醒`;
  const metric = {
    revenue: "销售额",
    orderCount: "订单数",
    unitsSold: "销量",
    averageOrderValue: "客单价",
  }[definition.metric];
  const operator = definition.operator === "below" ? "低于" : "高于";
  return `${frequency}检查近 ${definition.window.replace("d", " 天")} ${metric}，${operator} ${definition.threshold} 时提醒`;
}

function errorMessage(caught: unknown): string {
  return caught instanceof Error ? caught.message : "操作失败，请稍后重试";
}
