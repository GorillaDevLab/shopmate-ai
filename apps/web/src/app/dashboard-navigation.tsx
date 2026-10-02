"use client";

import Link from "next/link";
import { useId, useState, type ReactNode } from "react";
import { ThemeSettings } from "./theme-settings";
import { LogoutButton } from "./logout-button";

export type NavigationSection = "analytics" | "assistant";

type Props = {
  readonly active?: NavigationSection;
  readonly onMonitoring: () => void;
};

export function DashboardNavigation({ active = "analytics", onMonitoring }: Props) {
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const menuId = useId();
  const run = (action: () => void) => {
    setMobileOpen(false);
    action();
  };
  return (
    <aside className="workspace-sidebar" data-collapsed={collapsed} data-mobile-open={mobileOpen}>
      <div className="workspace-sidebar-inner">
        <button
          className="workspace-mobile-toggle focus-ring"
          aria-label={mobileOpen ? "关闭导航菜单" : "打开导航菜单"}
          aria-controls={menuId}
          aria-expanded={mobileOpen}
          onClick={() => setMobileOpen(!mobileOpen)}
        >
          <NavIcon kind="menu" />
          <span>导航菜单</span>
        </button>
        <div id={menuId} className="workspace-menu">
          <nav aria-label="工作台主导航">
            <NavLink href="/" icon="analytics" label="经营分析" current={active === "analytics"} />
            <NavLink href="/chat" icon="ai" label="AI 助手" current={active === "assistant"} />
            <NavButton icon="monitor" label="经营监听" onClick={() => run(onMonitoring)} />
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
            <NavIcon kind={collapsed ? "expand" : "collapse"} />
            <span>{collapsed ? "展开侧栏" : "收起侧栏"}</span>
          </button>
        </div>
      </div>
    </aside>
  );
}

function NavLink({
  href,
  icon,
  label,
  current,
}: {
  href: string;
  icon: IconKind;
  label: string;
  current: boolean;
}) {
  return (
    <Link href={href} aria-current={current ? "page" : undefined} title={label}>
      <NavIcon kind={icon} />
      <span>{label}</span>
    </Link>
  );
}

function NavButton({
  icon,
  label,
  onClick,
}: {
  icon: IconKind;
  label: string;
  onClick: () => void;
}) {
  return (
    <button type="button" title={label} aria-haspopup="dialog" onClick={onClick}>
      <NavIcon kind={icon} />
      <span>{label}</span>
    </button>
  );
}

type IconKind = "analytics" | "ai" | "monitor" | "menu" | "collapse" | "expand";

const ICON_PATHS: Record<IconKind, ReactNode> = {
  analytics: <path d="M4 20V11h3.5v9zm6.25 0V4h3.5v16zM16.5 20v-6H20v6z" />,
  ai: <path d="m12 3 2.3 6.2L20.5 11.5l-6.2 2.3L12 20l-2.3-6.2-6.2-2.3 6.2-2.3Z" />,
  monitor: <path d="M3 12h4l3-7 4 14 3-7h4" />,
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  collapse: <path d="M15 6l-6 6 6 6" />,
  expand: <path d="m9 6 6 6-6 6" />,
};

function NavIcon({ kind }: { kind: IconKind }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinejoin="round"
      strokeLinecap="round"
    >
      {ICON_PATHS[kind]}
    </svg>
  );
}
