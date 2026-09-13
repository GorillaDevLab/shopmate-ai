"use client";

import { useId, useState } from "react";
import { ThemeSettings } from "./theme-settings";
import { LogoutButton } from "./logout-button";

type Props = { onAssistant: () => void; onMonitoring: () => void };

export function DashboardNavigation({ onAssistant, onMonitoring }: Props) {
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const menuId = useId();
  const open = (action: () => void) => {
    setMobileOpen(false);
    action();
  };
  return (
    <aside className="workspace-sidebar" data-collapsed={collapsed} data-mobile-open={mobileOpen}>
      <div className="workspace-brand">
        <span>S</span>
        <strong>ShopMate AI</strong>
      </div>
      <button
        className="workspace-mobile-toggle focus-ring"
        aria-label={mobileOpen ? "关闭导航菜单" : "打开导航菜单"}
        aria-controls={menuId}
        aria-expanded={mobileOpen}
        onClick={() => setMobileOpen(!mobileOpen)}
      >
        ☰ <span>导航菜单</span>
      </button>
      <div id={menuId} className="workspace-menu">
        <p className="workspace-nav-label">经营工作台</p>
        <nav aria-label="工作台主导航">
          <a
            href="#main-content"
            aria-current="page"
            title="经营看板"
            onClick={() => setMobileOpen(false)}
          >
            <NavIcon kind="overview" />
            <span>经营看板</span>
          </a>
          <button
            type="button"
            title="AI 助手"
            aria-haspopup="dialog"
            onClick={() => open(onAssistant)}
          >
            <NavIcon kind="ai" />
            <span>AI 助手</span>
          </button>
          <button
            type="button"
            title="经营监听"
            aria-haspopup="dialog"
            onClick={() => open(onMonitoring)}
          >
            <NavIcon kind="monitor" />
            <span>经营监听</span>
          </button>
        </nav>
        <div className="workspace-settings">
          <ThemeSettings />
          <LogoutButton />
        </div>
        <button
          className="workspace-collapse focus-ring"
          aria-expanded={!collapsed}
          title={collapsed ? "展开侧栏" : "收起侧栏"}
          onClick={() => setCollapsed(!collapsed)}
        >
          {collapsed ? "→" : "←"}
          <span>{collapsed ? "展开侧栏" : "收起侧栏"}</span>
        </button>
      </div>
    </aside>
  );
}

function NavIcon({ kind }: { kind: "overview" | "ai" | "monitor" }) {
  const paths = {
    overview: "M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z",
    ai: "m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5Z",
    monitor: "M3 12h4l3-7 4 14 3-7h4",
  };
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinejoin="round"
    >
      <path d={paths[kind]} />
    </svg>
  );
}
