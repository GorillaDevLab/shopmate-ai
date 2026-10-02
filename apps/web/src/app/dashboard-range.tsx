"use client";

import { AnalyticsDashboardQuerySchema } from "@shopmate/contracts";
import { useEffect, useRef, useState, type FormEvent } from "react";

export type DashboardRange = { kind: "7" | "30" | "custom"; startDate?: string; endDate: string };
type DateRange = { startDate: string; endDate: string };
type RangeProps = {
  value: DashboardRange;
  latestDate: string;
  onChange: (value: DashboardRange) => void;
};
type FormProps = {
  initial: DateRange;
  latestDate: string;
  onCancel: () => void;
  onApply: (value: DateRange) => void;
};

export function daysBefore(date: string, days: number) {
  return new Date(Date.parse(date) - days * 86_400_000).toISOString().slice(0, 10);
}

export function DashboardRangeControls(props: RangeProps) {
  const [open, setOpen] = useState(false);
  const { value } = props;
  return (
    <div className="min-w-0 sm:text-right">
      <RangeButtons {...props} onCustom={() => setOpen(true)} />
      <p className="mt-1.5 text-xs tabular-nums text-app-muted">
        {value.startDate ?? daysBefore(value.endDate, 6)} — {value.endDate} · 上海时间
      </p>
      {open && <RangeDialog {...props} onClose={() => setOpen(false)} />}
    </div>
  );
}

function RangeButtons({
  value,
  latestDate,
  onChange,
  onCustom,
}: RangeProps & { onCustom: () => void }) {
  const choose = (kind: DashboardRange["kind"]) => {
    if (kind === "custom") return onCustom();
    onChange({
      kind,
      endDate: latestDate,
      startDate: kind === "30" ? daysBefore(latestDate, 29) : undefined,
    });
  };
  return (
    <div role="group" aria-label="经营统计时段" className="range-segments" data-range={value.kind}>
      <span aria-hidden="true" className="range-indicator" />
      {(["7", "30", "custom"] as const).map((kind) => (
        <button
          key={kind}
          type="button"
          aria-pressed={value.kind === kind}
          onClick={() => choose(kind)}
          className={`min-h-11 rounded-lg px-3 text-sm font-semibold focus-ring sm:px-4 ${value.kind === kind ? "text-white" : "text-app-muted hover:text-app-text"}`}
        >
          {kind === "custom" ? "自选时段" : `近 ${kind} 天`}
        </button>
      ))}
    </div>
  );
}

function RangeDialog({
  value,
  latestDate,
  onChange,
  onClose,
}: RangeProps & { onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  const apply = (dates: DateRange) => {
    onChange({ kind: "custom", ...dates });
    dialog.current?.close();
  };
  return (
    <dialog
      ref={dialog}
      onClose={onClose}
      aria-labelledby="range-title"
      className="fixed inset-0 m-auto w-[calc(100%_-_2rem)] max-w-sm rounded-3xl border border-app-line bg-app-surface p-6 text-left text-app-text shadow-xl backdrop:bg-black/30"
    >
      <RangeForm
        initial={{
          startDate: value.startDate ?? daysBefore(value.endDate, 6),
          endDate: value.endDate,
        }}
        latestDate={latestDate}
        onCancel={() => dialog.current?.close()}
        onApply={apply}
      />
    </dialog>
  );
}

function RangeForm({ initial, latestDate, onCancel, onApply }: FormProps) {
  const [dates, setDates] = useState(initial);
  const [error, setError] = useState("");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const parsed = AnalyticsDashboardQuerySchema.safeParse({
      startDate: dates.startDate,
      asOfDate: dates.endDate,
    });
    if (!parsed.success || dates.endDate > latestDate) {
      setError("请选择有效日期：开始不晚于结束，且不能晚于今天。");
      return;
    }
    onApply(dates);
  };
  return (
    <form onSubmit={submit} noValidate>
      <RangeFormHeading />
      <RangeFields
        dates={dates}
        latestDate={latestDate}
        invalid={Boolean(error)}
        onChange={(next) => {
          setDates(next);
          setError("");
        }}
      />
      {error && (
        <p id="range-error" role="alert" className="mt-3 text-sm text-rose-700">
          {error}
        </p>
      )}
      <RangeActions onCancel={onCancel} />
    </form>
  );
}

type FieldsProps = {
  dates: DateRange;
  latestDate: string;
  invalid: boolean;
  onChange: (next: DateRange) => void;
};
function RangeFormHeading() {
  return (
    <>
      <h2 id="range-title" className="text-xl font-bold">
        自选统计时段
      </h2>
      <p className="mt-2 text-sm text-app-muted">
        支持任意历史时段，与前一个等长时段比较。库存为当前快照。
      </p>
    </>
  );
}
function RangeFields({ dates, latestDate, invalid, onChange }: FieldsProps) {
  return (["startDate", "endDate"] as const).map((field) => (
    <label key={field} className="mt-4 block text-sm font-semibold">
      {field === "startDate" ? "开始日期" : "结束日期"}
      <input
        type="date"
        required
        min="1000-01-01"
        max={latestDate}
        value={dates[field]}
        aria-invalid={invalid}
        aria-describedby={invalid ? "range-error" : undefined}
        className="mt-2 min-h-11 w-full min-w-0 rounded-xl border border-app-line bg-app-bg px-3 text-app-text focus-ring"
        onChange={(event) => onChange({ ...dates, [field]: event.target.value })}
      />
    </label>
  ));
}

function RangeActions({ onCancel }: { onCancel: () => void }) {
  return (
    <div className="mt-6 flex justify-end gap-2">
      <button
        type="button"
        className="min-h-11 rounded-xl px-4 text-sm focus-ring"
        onClick={onCancel}
      >
        取消
      </button>
      <button
        type="submit"
        className="min-h-11 rounded-xl bg-brand px-4 text-sm font-bold text-white focus-ring"
      >
        应用时段
      </button>
    </div>
  );
}

export function shanghaiToday(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: "Asia/Shanghai",
  }).formatToParts(now);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}
