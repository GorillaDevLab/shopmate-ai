"use client";

import { useEffect, useRef, useState } from "react";
import { applyTheme, themeValue, THEME_STORAGE_ERROR, type Theme } from "./theme";

export function ThemeSettings() {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };
  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="appearance-trigger focus-ring"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        <SettingsIcon />
        外观设置
      </button>
      {open && <AppearanceDialog onClose={close} />}
    </>
  );
}

function SettingsIcon() {
  return (
    <svg
      aria-hidden="true"
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="m9 3-.6 2.4-2 .9L4 5.6 2 9l1.8 1.7v2.6L2 15l2 3.4 2.4-.7 2 .9L9 21h4l.6-2.4 2-.9 2.4.7 2-3.4-1.8-1.7v-2.6L20 9l-2-3.4-2.4.7-2-.9L13 3Z" />
      <circle cx="11" cy="12" r="3" />
    </svg>
  );
}

function AppearanceDialog({ onClose }: { onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [theme, setTheme] = useState(() => themeValue(document.documentElement.dataset.theme));
  const [error, setError] = useState(() =>
    document.documentElement.dataset.themeStorageError ? THEME_STORAGE_ERROR : "",
  );
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  const choose = (next: Theme) => {
    setError(applyTheme(next));
    setTheme(next);
  };
  return (
    <dialog
      ref={dialog}
      onClose={onClose}
      aria-labelledby="appearance-title"
      aria-describedby="appearance-description"
      className="appearance-dialog"
    >
      <AppearanceHeading onClose={() => dialog.current?.close()} />
      <AppearanceChoices theme={theme} onChange={choose} error={error} />
    </dialog>
  );
}

function AppearanceHeading({ onClose }: { onClose: () => void }) {
  return (
    <>
      <div className="flex items-center justify-between gap-3">
        <h2 id="appearance-title" className="text-xl font-semibold">
          外观设置
        </h2>
        <button
          type="button"
          aria-label="关闭外观设置"
          className="dialog-close focus-ring"
          onClick={onClose}
        >
          ×
        </button>
      </div>
      <p id="appearance-description" className="mt-1 text-sm text-app-muted">
        让工作台，适合你的习惯。
      </p>
    </>
  );
}

function AppearanceChoices({
  theme,
  onChange,
  error,
}: {
  theme: Theme;
  onChange: (theme: Theme) => void;
  error: string;
}) {
  return (
    <>
      <fieldset className="mt-6">
        <legend className="mb-3 text-xs font-semibold text-app-muted">界面主题</legend>
        <div className="grid grid-cols-2 gap-3">
          {(["terracotta", "purple"] as const).map((value) => (
            <ThemeOption key={value} value={value} checked={theme === value} onChange={onChange} />
          ))}
        </div>
      </fieldset>
      <p className="mt-5 text-xs leading-5 text-app-muted">
        立即生效 · 仅保存在当前浏览器，不影响经营数据。
      </p>
      {error && (
        <p role="alert" className="mt-3 text-xs leading-5 text-danger">
          {error}
        </p>
      )}
    </>
  );
}

function ThemeOption({
  value,
  checked,
  onChange,
}: {
  value: Theme;
  checked: boolean;
  onChange: (theme: Theme) => void;
}) {
  const name = value === "terracotta" ? "暖灰陶土" : "经典紫色";
  return (
    <label className="theme-option">
      <input
        className="peer sr-only"
        type="radio"
        name="appearance-theme"
        value={value}
        aria-label={name}
        checked={checked}
        onChange={() => onChange(value)}
      />
      <ThemePreview value={value} />
      <span className="mt-3 flex items-center justify-between gap-1 text-sm font-semibold">
        {name}
        <span aria-hidden="true" className="theme-check">
          {checked ? "✓" : ""}
        </span>
      </span>
    </label>
  );
}

function ThemePreview({ value }: { value: Theme }) {
  return (
    <span className="theme-preview" data-preview={value} aria-hidden="true">
      <span className="preview-nav">
        <i />
        <b />
      </span>
      <span className="preview-metrics">
        <i />
        <i />
        <i />
      </span>
      <span className="preview-chart">
        <svg viewBox="0 0 120 40">
          <path d="M0 35 20 25 40 30 60 12 80 19 100 5 120 10" />
        </svg>
      </span>
    </span>
  );
}
