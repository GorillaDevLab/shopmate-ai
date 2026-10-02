"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useState, type FormEvent, type ReactNode } from "react";

import { useAssistantWorkspace } from "./assistant/provider";
import { DashboardNavigation, type NavigationSection } from "./dashboard-navigation";
import { MonitoringRuleManager } from "./monitoring-rule-manager";
import { NotificationCenter } from "./notification-center";

// 与助手草稿、聊天接口 schema 的 content 上限保持一致。
export const SEARCH_MAX_LENGTH = 2000;

type Props = {
  readonly active: NavigationSection;
  readonly children: ReactNode;
  readonly notificationsEnabled?: boolean;
  /** 内容区占满视口剩余高度并自行滚动（如对话页）。 */
  readonly fill?: boolean;
};

export function AppShell({ active, children, notificationsEnabled = true, fill = false }: Props) {
  const [monitoringOpen, setMonitoringOpen] = useState(false);
  return (
    <div className={`workspace-layout app-shell${fill ? " app-shell--fill" : ""}`}>
      <ShellTopbar notificationsEnabled={notificationsEnabled} />
      <div className="app-shell-body">
        <DashboardNavigation active={active} onMonitoring={() => setMonitoringOpen(true)} />
        <main className="app-shell-main">{children}</main>
      </div>
      <MonitoringRuleManager open={monitoringOpen} onOpenChange={setMonitoringOpen} />
    </div>
  );
}

function ShellTopbar({ notificationsEnabled }: { notificationsEnabled: boolean }) {
  return (
    <header className="app-topbar">
      <Link href="/" className="app-brand focus-ring">
        <span aria-hidden="true">S</span>
        ShopMate AI
      </Link>
      <TopbarSearch />
      <div className="app-topbar-actions">
        <NotificationCenter enabled={notificationsEnabled} />
        <span className="app-merchant">
          <span aria-hidden="true">商</span>
          <span className="app-merchant-name">商家账号</span>
        </span>
      </div>
    </header>
  );
}

function TopbarSearch() {
  const id = useId();
  const router = useRouter();
  const { store } = useAssistantWorkspace();
  const [value, setValue] = useState("");
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const query = value.trim().slice(0, SEARCH_MAX_LENGTH);
    if (!query) return;
    // 只写入草稿，不自动发送：商家在助手里确认后再提交。
    store.setDraft(query);
    setValue("");
    router.push("/chat");
  };
  return (
    <form role="search" className="app-search" onSubmit={submit}>
      <label className="sr-only" htmlFor={id}>
        搜索或问 AI
      </label>
      <svg aria-hidden="true" viewBox="0 0 24 24" width="16" height="16">
        <circle cx="11" cy="11" r="7" />
        <path d="m20 20-3.5-3.5" />
      </svg>
      <input
        id={id}
        type="search"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        maxLength={SEARCH_MAX_LENGTH}
        autoComplete="off"
        placeholder="搜索商品、订单，或直接问 AI"
      />
    </form>
  );
}
