"use client";

import { DEFAULT_ANALYTICS_LAYOUT, type AnalyticsLayout } from "@shopmate/contracts";
import { useEffect, useState } from "react";

import { isAbortError } from "../dashboard-api";
import { fetchAnalyticsLayout, saveAnalyticsLayout } from "./analytics-layout-api";

type Saved =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly layout: AnalyticsLayout; readonly revision: number }
  // 读取失败时仍按默认布局展示数据，但先重新读取成功才能编辑，避免用默认布局覆盖已保存的布局。
  | { readonly status: "error"; readonly message: string };

export type LayoutEditor = ReturnType<typeof useAnalyticsLayout>;

export function useAnalyticsLayout() {
  const { saved, setSaved, reload } = useSavedLayout();
  const [draft, setDraft] = useState<AnalyticsLayout | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const startEdit = async () => {
    const current = saved.status === "error" ? await reload() : saved;
    if (current.status === "ready") setDraft(current.layout);
  };

  const save = async () => {
    if (!draft || saved.status !== "ready" || saving) return;
    setSaving(true);
    setError(null);
    try {
      const response = await saveAnalyticsLayout(draft, saved.revision);
      setSaved({ status: "ready", layout: response.layout, revision: response.revision });
      setDraft(null);
    } catch (reason: unknown) {
      setError(messageOf(reason));
    } finally {
      setSaving(false);
    }
  };

  return {
    loading: saved.status === "loading",
    layout: draft ?? (saved.status === "ready" ? saved.layout : DEFAULT_ANALYTICS_LAYOUT),
    editing: draft !== null,
    loadError: saved.status === "error" ? saved.message : null,
    saving,
    error,
    startEdit: () => void startEdit(),
    cancel: () => {
      setDraft(null);
      setError(null);
    },
    update: (change: (layout: AnalyticsLayout) => AnalyticsLayout) =>
      setDraft((current) => (current ? change(current) : current)),
    save,
  };
}

function useSavedLayout() {
  const [saved, setSaved] = useState<Saved>({ status: "loading" });

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal).then((next) => {
      if (next) setSaved(next);
    });
    return () => controller.abort();
  }, []);

  // 重试时不回到 loading，避免已显示的数据闪回骨架屏。
  const reload = async (): Promise<Saved> => {
    const next = (await load()) ?? { status: "error", message: "布局服务暂时不可用" };
    setSaved(next);
    return next;
  };

  return { saved, setSaved, reload };
}

/** 被中止时返回 null（组件已卸载，不再更新状态）。 */
async function load(signal?: AbortSignal): Promise<Saved | null> {
  try {
    const response = await fetchAnalyticsLayout(signal);
    return { status: "ready", layout: response.layout, revision: response.revision };
  } catch (reason: unknown) {
    if (isAbortError(reason)) return null;
    return { status: "error", message: messageOf(reason) };
  }
}

function messageOf(reason: unknown): string {
  return reason instanceof Error && reason.message ? reason.message : "布局服务暂时不可用";
}
