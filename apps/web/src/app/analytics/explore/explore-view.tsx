"use client";

import Link from "next/link";
import { useId, useState, type FormEvent } from "react";

import { AppShell } from "../../app-shell";
import { SparkIcon } from "../analytics-panels";
import type { ExploreState, SaveState } from "./explore-client";
import { ExploreChart } from "./explore-chart";
import { ConfigPanel } from "./explore-config";
import {
  EXAMPLE_PROMPTS,
  METRIC_OPTIONS,
  DIMENSION_LABELS,
  isEmptyResult,
  resultRows,
} from "./explore-model";
import type { ConfigPatch } from "./explore-model";

const QUESTION_MAX_LENGTH = 2000;

type Props = {
  readonly state: ExploreState;
  readonly save: SaveState;
  readonly onGenerate: (question: string) => void;
  readonly onConfigChange: (patch: ConfigPatch) => void;
  readonly onAddToDashboard: () => void;
};

export function ExploreView({ state, save, onGenerate, onConfigChange, onAddToDashboard }: Props) {
  return (
    <AppShell active="analytics">
      <div className="analytics-page explore-page" id="main-content">
        <header className="explore-header">
          <nav aria-label="位置" className="explore-breadcrumb">
            <Link href="/analytics">经营分析</Link>
            <span aria-hidden="true">/</span>
            <span aria-current="page">AI 图表探索</span>
          </nav>
          <h1>AI 图表探索</h1>
        </header>
        <PromptForm busy={state.status === "generating"} onSubmit={onGenerate} />
        {state.status === "idle" && <IdleState onPick={onGenerate} />}
        {state.status === "generating" && (
          <div className="analytics-state" role="status" aria-live="polite">
            <div className="analytics-skeleton" aria-hidden="true">
              {Array.from({ length: 4 }, (_, i) => (
                <span key={i} />
              ))}
            </div>
            <p>AI 正在理解问题并查询经营数据…</p>
          </div>
        )}
        {state.status === "error" && (
          <GenerateError state={state} onRetry={() => onGenerate(state.question)} />
        )}
        {state.status === "ready" && (
          <ReadyState
            state={state}
            save={save}
            onConfigChange={onConfigChange}
            onAddToDashboard={onAddToDashboard}
          />
        )}
      </div>
    </AppShell>
  );
}

function PromptForm({ busy, onSubmit }: { busy: boolean; onSubmit: (question: string) => void }) {
  const id = useId();
  const [value, setValue] = useState("");
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const question = value.trim().slice(0, QUESTION_MAX_LENGTH);
    if (question && !busy) onSubmit(question);
  };
  return (
    <form className="analytics-card explore-prompt" onSubmit={submit}>
      <label htmlFor={id}>想看什么图表？</label>
      <textarea
        id={id}
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey))
            event.currentTarget.form?.requestSubmit();
        }}
        maxLength={QUESTION_MAX_LENGTH}
        rows={2}
        placeholder="例如：近 30 天各门店和店铺的销售额对比"
      />
      <div className="explore-prompt-actions">
        <p className="muted">每次生成都会调用 AI 模型；生成后调整图表配置不会再次调用。</p>
        <button type="submit" className="btn-primary" disabled={busy || !value.trim()}>
          <SparkIcon size={15} />
          {busy ? "生成中…" : "生成图表"}
        </button>
      </div>
    </form>
  );
}

function IdleState({ onPick }: { onPick: (question: string) => void }) {
  return (
    <section className="analytics-state explore-idle" aria-label="示例问题">
      <h2>用一句话描述你想看的数据</h2>
      <p>AI 会选好指标、分组和图表类型，你可以再调整图表配置，满意后加入经营看板。</p>
      <div className="explore-examples">
        {EXAMPLE_PROMPTS.map((prompt) => (
          <button
            key={prompt}
            type="button"
            className="btn-secondary"
            onClick={() => onPick(prompt)}
          >
            {prompt}
          </button>
        ))}
      </div>
    </section>
  );
}

function GenerateError({
  state,
  onRetry,
}: {
  state: Extract<ExploreState, { status: "error" }>;
  onRetry: () => void;
}) {
  return (
    <div className="analytics-state" role="alert">
      <h2>图表生成失败</h2>
      <p>{state.message}</p>
      <div className="analytics-state-actions">
        {state.authRequired ? (
          <a className="btn-primary" href="/login">
            重新登录
          </a>
        ) : (
          <button type="button" className="btn-secondary" onClick={onRetry}>
            重新生成
          </button>
        )}
      </div>
    </div>
  );
}

type Ready = Extract<ExploreState, { status: "ready" }>;

function ReadyState({
  state,
  save,
  onConfigChange,
  onAddToDashboard,
}: {
  state: Ready;
  save: SaveState;
  onConfigChange: (patch: ConfigPatch) => void;
  onAddToDashboard: () => void;
}) {
  const { result, query } = state;
  const empty = isEmptyResult(result);
  return (
    <div className="explore-layout">
      <div className="explore-main">
        <article
          className={`analytics-card explore-result${state.updating ? " is-refreshing" : ""}`}
          aria-busy={state.updating}
          aria-label={result.title}
        >
          <div className="explore-result-head">
            <div>
              <h2>{result.title}</h2>
              <p className="muted">{result.summary}</p>
              <p className="explore-question">问题：{state.question}</p>
            </div>
            <SaveButton save={save} disabled={state.updating || empty} onClick={onAddToDashboard} />
          </div>
          {state.updateError && (
            <p className="explore-inline-error" role="alert">
              {state.updateError}
            </p>
          )}
          {empty ? (
            <p className="card-note">这个时段没有可展示的数据，试试放宽日期范围或换一个指标。</p>
          ) : (
            <ExploreChart result={result} view={query.visualization} />
          )}
        </article>
        {!empty && <ResultTable state={state} />}
      </div>
      <ConfigPanel query={query} onChange={onConfigChange} />
    </div>
  );
}

function SaveButton({
  save,
  disabled,
  onClick,
}: {
  save: SaveState;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <div className="explore-save">
      <button
        type="button"
        className="btn-primary"
        disabled={disabled || save.status === "saving" || save.status === "saved"}
        onClick={onClick}
      >
        {save.status === "saving"
          ? "正在加入…"
          : save.status === "saved"
            ? "已加入看板"
            : "加入经营看板"}
      </button>
      <p className="explore-save-status" role="status" aria-live="polite">
        {save.status === "saved" && <Link href="/">去经营看板查看</Link>}
        {save.status === "error" && <span className="explore-inline-error">{save.message}</span>}
      </p>
    </div>
  );
}

function ResultTable({ state }: { state: Ready }) {
  const { query, result } = state;
  const metric = METRIC_OPTIONS.find((option) => option.value === query.metric)?.label ?? "数值";
  const dimension = query.groupBy ? DIMENSION_LABELS[query.groupBy].replace(/^按\s?/, "") : "项目";
  return (
    <section className="analytics-card" aria-label="数据明细">
      <h3 className="analytics-card-title">
        <span>数据明细</span>
      </h3>
      <div className="explore-table-wrap">
        <table className="explore-table">
          <thead>
            <tr>
              <th scope="col">{result.kind === "series" ? "日期" : dimension}</th>
              <th scope="col">{result.kind === "report" ? "数值" : metric}</th>
            </tr>
          </thead>
          <tbody>
            {resultRows(result).map((row) => (
              <tr key={row.key}>
                <th scope="row">{row.label}</th>
                <td>{row.value}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
