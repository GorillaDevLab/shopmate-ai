"use client";

import { getDashboardInsightViews, type DashboardInsightQuery } from "@shopmate/contracts";
import { useId, useState, type ReactNode } from "react";

import { shanghaiToday } from "../../dashboard-range";
import {
  DIMENSION_LABELS,
  LIMIT_OPTIONS,
  METRIC_OPTIONS,
  VIEW_LABELS,
  type ConfigPatch,
} from "./explore-model";

const NO_GROUP = "none";

export function ConfigPanel({
  query,
  onChange,
}: {
  query: DashboardInsightQuery;
  onChange: (patch: ConfigPatch) => void;
}) {
  const metric =
    METRIC_OPTIONS.find((option) => option.value === query.metric) ?? METRIC_OPTIONS[0];
  const views = getDashboardInsightViews(query);
  return (
    <aside className="analytics-card explore-config" aria-label="图表配置">
      <h2 className="analytics-card-title">
        <span>图表配置</span>
      </h2>
      <Field label="指标">
        {(id) => (
          <select
            id={id}
            value={query.metric}
            onChange={(event) =>
              onChange({ metric: event.target.value as DashboardInsightQuery["metric"] })
            }
          >
            {METRIC_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        )}
      </Field>
      <Field label="分组">
        {(id) => (
          <select
            id={id}
            value={query.groupBy ?? NO_GROUP}
            onChange={(event) => {
              const value = event.target.value;
              onChange({
                groupBy:
                  value === NO_GROUP
                    ? null
                    : (value as NonNullable<DashboardInsightQuery["groupBy"]>),
              });
            }}
          >
            {metric.dimensions.map((dimension) => (
              <option key={dimension} value={dimension}>
                {DIMENSION_LABELS[dimension]}
              </option>
            ))}
            <option value={NO_GROUP}>不分组（文字报告）</option>
          </select>
        )}
      </Field>
      <fieldset className="explore-field">
        <legend>图表类型</legend>
        <div className="explore-views" role="group">
          {views.map((view) => (
            <button
              key={view}
              type="button"
              aria-pressed={query.visualization === view}
              onClick={() => onChange({ visualization: view })}
            >
              {VIEW_LABELS[view]}
            </button>
          ))}
        </div>
      </fieldset>
      <DateRangeFields
        key={`${query.dateRange.start}/${query.dateRange.end}`}
        range={query.dateRange}
        onChange={(dateRange) => onChange({ dateRange })}
      />
      {query.groupBy !== null && query.groupBy !== "date" && (
        <RankingFields query={query} onChange={onChange} />
      )}
    </aside>
  );
}

function RankingFields({
  query,
  onChange,
}: {
  query: DashboardInsightQuery;
  onChange: (patch: ConfigPatch) => void;
}) {
  return (
    <div className="explore-field-row">
      <Field label="排序">
        {(id) => (
          <select
            id={id}
            value={query.order}
            onChange={(event) => onChange({ order: event.target.value === "asc" ? "asc" : "desc" })}
          >
            <option value="desc">从高到低</option>
            <option value="asc">从低到高</option>
          </select>
        )}
      </Field>
      <Field label="显示数量">
        {(id) => (
          <select
            id={id}
            value={query.limit}
            onChange={(event) => onChange({ limit: Number(event.target.value) })}
          >
            {[...new Set([...LIMIT_OPTIONS, query.limit])]
              .sort((a, b) => a - b)
              .map((limit) => (
                <option key={limit} value={limit}>
                  前 {limit} 项
                </option>
              ))}
          </select>
        )}
      </Field>
    </div>
  );
}

function DateRangeFields({
  range,
  onChange,
}: {
  range: DashboardInsightQuery["dateRange"];
  onChange: (range: DashboardInsightQuery["dateRange"]) => void;
}) {
  const [draft, setDraft] = useState(range);
  const [error, setError] = useState("");
  const today = shanghaiToday();
  const commit = (next: DashboardInsightQuery["dateRange"]) => {
    setDraft(next);
    if (!next.start || !next.end || next.start > next.end || next.end > today) {
      setError("请选择有效日期：开始不晚于结束，且不能晚于今天。");
      return;
    }
    setError("");
    if (next.start !== range.start || next.end !== range.end) onChange(next);
  };
  return (
    <div className="explore-field-row">
      <Field label="开始日期">
        {(id) => (
          <input
            id={id}
            type="date"
            value={draft.start}
            max={today}
            onChange={(event) => commit({ ...draft, start: event.target.value })}
          />
        )}
      </Field>
      <Field label="结束日期">
        {(id) => (
          <input
            id={id}
            type="date"
            value={draft.end}
            max={today}
            onChange={(event) => commit({ ...draft, end: event.target.value })}
          />
        )}
      </Field>
      {error && (
        <p className="explore-inline-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: (id: string) => ReactNode }) {
  const id = useId();
  return (
    <div className="explore-field">
      <label htmlFor={id}>{label}</label>
      {children(id)}
    </div>
  );
}
