"use client";

import type { MonitoringNotificationView } from "@shopmate/contracts";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  getMonitoringUnreadCount,
  listMonitoringNotifications,
  markAllMonitoringNotificationsRead,
  markMonitoringNotificationRead,
  syncMonitoring,
} from "./monitoring-api";

export function NotificationCenter({ enabled = true }: { readonly enabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const [count, setCount] = useState(0);
  const [items, setItems] = useState<MonitoringNotificationView[]>([]);
  const [state, setState] = useState<"idle" | "loading" | "error">("idle");
  const [mutationError, setMutationError] = useState("");
  const [pendingMutation, setPendingMutation] = useState<string>();
  const pendingMutationRef = useRef<string>();
  const synced = useRef(false);

  const refreshCount = useCallback(async () => {
    setCount((await getMonitoringUnreadCount()).count);
  }, []);

  useEffect(() => {
    if (!enabled || synced.current) return;
    synced.current = true;
    void syncMonitoring()
      .then(refreshCount)
      .catch(() => undefined);
  }, [enabled, refreshCount]);

  async function openCenter() {
    setOpen(true);
    setState("loading");
    setMutationError("");
    try {
      setItems((await listMonitoringNotifications()).items);
      setState("idle");
    } catch {
      setState("error");
    }
  }

  async function markRead(item: MonitoringNotificationView) {
    if (pendingMutationRef.current) return;
    pendingMutationRef.current = item.id;
    setPendingMutation(item.id);
    setMutationError("");
    try {
      const updated = await markMonitoringNotificationRead(item.id);
      setItems((current) =>
        current.map((entry) => (entry.id === item.id ? updated.notification : entry)),
      );
      setCount((current) => Math.max(0, current - (item.readAt ? 0 : 1)));
    } catch {
      setMutationError("标记失败，请稍后重试");
    } finally {
      pendingMutationRef.current = undefined;
      setPendingMutation(undefined);
    }
  }

  async function markAllRead() {
    if (pendingMutationRef.current) return;
    pendingMutationRef.current = "all";
    setPendingMutation("all");
    setMutationError("");
    try {
      await markAllMonitoringNotificationsRead();
      const readAt = new Date().toISOString();
      setItems((current) => current.map((item) => ({ ...item, readAt: item.readAt ?? readAt })));
      setCount(0);
    } catch {
      setMutationError("标记失败，请稍后重试");
    } finally {
      pendingMutationRef.current = undefined;
      setPendingMutation(undefined);
    }
  }

  return (
    <>
      <button
        type="button"
        className="header-icon-button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={count ? `通知，${count} 条未读` : "通知"}
        onClick={() => void openCenter()}
      >
        <span aria-hidden="true">◔</span>
        {count > 0 && <span className="notification-badge">{count > 99 ? "99+" : count}</span>}
      </button>
      {open && (
        <div
          className="monitoring-overlay"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setOpen(false);
          }}
        >
          <section
            className="notification-sheet"
            role="dialog"
            aria-modal="true"
            aria-labelledby="notification-title"
          >
            <header className="monitoring-sheet-header">
              <div>
                <span className="monitoring-eyebrow">只展示你的店铺</span>
                <h2 id="notification-title">通知</h2>
              </div>
              <button
                type="button"
                className="icon-button"
                aria-label="关闭通知"
                onClick={() => setOpen(false)}
              >
                ×
              </button>
            </header>
            <div className="notification-toolbar">
              <span>{count ? `${count} 条未读` : "已全部读完"}</span>
              {count > 0 && (
                <button
                  type="button"
                  disabled={pendingMutation !== undefined}
                  onClick={() => void markAllRead()}
                >
                  全部已读
                </button>
              )}
            </div>
            {mutationError && (
              <div className="monitoring-error" role="alert">
                {mutationError}
              </div>
            )}
            <NotificationList
              state={state}
              items={items}
              pendingMutation={pendingMutation}
              onRead={markRead}
              onRetry={() => void openCenter()}
            />
          </section>
        </div>
      )}
    </>
  );
}

function NotificationList({
  state,
  items,
  pendingMutation,
  onRead,
  onRetry,
}: {
  readonly state: "idle" | "loading" | "error";
  readonly items: MonitoringNotificationView[];
  readonly pendingMutation: string | undefined;
  readonly onRead: (item: MonitoringNotificationView) => Promise<void>;
  readonly onRetry: () => void;
}) {
  if (state === "loading")
    return (
      <div className="monitoring-state" role="status">
        正在读取通知…
      </div>
    );
  if (state === "error")
    return (
      <div className="monitoring-state" role="alert">
        通知加载失败。
        <button type="button" onClick={onRetry}>
          重试
        </button>
      </div>
    );
  if (!items.length)
    return (
      <div className="monitoring-state">
        <strong>暂时没有提醒</strong>
        <p>规则命中后会出现在这里。</p>
      </div>
    );
  return (
    <ul className="notification-list">
      {items.map((item) => (
        <li key={item.id} className={item.readAt ? "is-read" : ""}>
          <span className="notification-severity" aria-hidden="true" />
          <div>
            <div className="notification-meta">
              <strong>{item.ruleName}</strong>
              <time>{formatRelativeDate(item.createdAt)}</time>
            </div>
            <h3>{item.title}</h3>
            <p>{item.message}</p>
          </div>
          {!item.readAt && (
            <button
              type="button"
              aria-label={`标记${item.ruleName}为已读`}
              disabled={pendingMutation !== undefined}
              onClick={() => void onRead(item)}
            >
              标为已读
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

function formatRelativeDate(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}
