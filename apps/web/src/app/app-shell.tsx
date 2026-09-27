"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from "react";

import { LogoutButton } from "./logout-button";
import { NotificationCenter } from "./notification-center";
import { ThemeSettings } from "./theme-settings";

export type AppSection = "dashboard" | "chat";

// 与聊天接口 schema 的 content 上限保持一致，超长内容在提交前就被浏览器截断。
const SEARCH_MAX_LENGTH = 2000;

const NAV_ITEMS = [
  { key: "dashboard", href: "/", label: "经营看板", icon: DashboardIcon },
  { key: "chat", href: "/chat", label: "AI 对话", icon: ChatIcon },
] as const;

interface AppShellProps {
  readonly active: AppSection;
  readonly title: string;
  readonly actions?: ReactNode;
  readonly notificationsEnabled?: boolean;
  readonly children: ReactNode;
}

export function AppShell({
  active,
  title,
  actions,
  notificationsEnabled = true,
  children,
}: AppShellProps) {
  const [navOpen, setNavOpen] = useState(false);
  const menuTrigger = useRef<HTMLButtonElement>(null);
  const closeNav = () => {
    setNavOpen(false);
    menuTrigger.current?.focus();
  };
  return (
    <div className="min-h-dvh bg-app-bg text-app-text lg:pl-64">
      <a className="skip-link" href="#main-content">
        跳到主要内容
      </a>
      <aside className="app-sidebar fixed inset-y-0 left-0 z-40 hidden w-64 lg:flex">
        <SidebarContent active={active} />
      </aside>
      <div className="flex min-h-dvh min-w-0 flex-col">
        <AppToolbar
          title={title}
          actions={actions}
          notificationsEnabled={notificationsEnabled}
          menuTrigger={menuTrigger}
          navOpen={navOpen}
          onOpenNav={() => setNavOpen(true)}
        />
        <main id="main-content" className="min-w-0 flex-1 px-4 py-4 md:px-6 md:py-6">
          {children}
        </main>
      </div>
      {navOpen && <NavDrawer active={active} onClose={closeNav} />}
    </div>
  );
}

function AppToolbar({
  title,
  actions,
  notificationsEnabled,
  menuTrigger,
  navOpen,
  onOpenNav,
}: {
  title: string;
  actions?: ReactNode;
  notificationsEnabled: boolean;
  menuTrigger: RefObject<HTMLButtonElement | null>;
  navOpen: boolean;
  onOpenNav: () => void;
}) {
  return (
    <header className="app-toolbar sticky top-0 z-30 flex h-16 items-center gap-2 border-b border-app-line bg-app-surface px-4 md:gap-3 md:px-6">
      <button
        ref={menuTrigger}
        type="button"
        className="toolbar-icon-button lg:hidden"
        aria-label="打开导航菜单"
        aria-haspopup="dialog"
        aria-expanded={navOpen}
        onClick={onOpenNav}
      >
        <MenuIcon />
      </button>
      <p className="min-w-0 truncate text-sm font-semibold tracking-tight md:text-base">{title}</p>
      <SearchForm className="ml-auto hidden w-full max-w-xs md:block" />
      <div className="ml-auto flex shrink-0 items-center gap-2 md:ml-0">
        {actions}
        <NotificationCenter enabled={notificationsEnabled} />
        <UserBadge />
      </div>
    </header>
  );
}

function SearchForm({ className = "" }: { className?: string }) {
  const id = useId();
  return (
    <form role="search" action="/chat" method="get" className={className}>
      <label className="sr-only" htmlFor={id}>
        搜索或提问
      </label>
      <input
        id={id}
        name="q"
        type="search"
        required
        maxLength={SEARCH_MAX_LENGTH}
        autoComplete="off"
        placeholder="搜索商品、库存，或直接提问…"
        className="app-input min-h-10 w-full px-3"
      />
    </form>
  );
}

function UserBadge() {
  return (
    <div className="hidden items-center gap-2 border-l border-app-line pl-3 sm:flex">
      <span aria-hidden="true" className="user-avatar">
        商
      </span>
      <span className="hidden text-sm font-medium xl:inline">商家账号</span>
    </div>
  );
}

function SidebarContent({ active, search }: { active: AppSection; search?: ReactNode }) {
  return (
    <div className="flex h-full w-full flex-col bg-gray-900 text-gray-300">
      <Link
        href="/"
        className="flex h-16 shrink-0 items-center gap-3 border-b border-white/10 px-5 focus-ring"
      >
        <span className="grid size-8 place-items-center rounded-lg bg-brand text-sm font-semibold text-white">
          S
        </span>
        <span className="text-base font-semibold tracking-tight text-white">ShopMate AI</span>
      </Link>
      {search && <div className="px-3 pt-4">{search}</div>}
      <nav aria-label="主导航" className="flex-1 overflow-y-auto px-3 py-4">
        <ul className="grid gap-1">
          {NAV_ITEMS.map(({ key, href, label, icon: Icon }) => (
            <li key={key}>
              <Link
                href={href}
                aria-current={key === active ? "page" : undefined}
                className="sidebar-link"
              >
                <Icon />
                {label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      <SidebarAccount />
    </div>
  );
}

function SidebarAccount() {
  return (
    <div className="grid gap-2 border-t border-white/10 p-3">
      <div className="flex items-center gap-3 px-2 py-1">
        <span aria-hidden="true" className="user-avatar is-dark">
          商
        </span>
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-white">商家账号</p>
          <p className="truncate text-xs text-gray-400">经营工作台</p>
        </div>
      </div>
      <ThemeSettings variant="sidebar" />
      <LogoutButton variant="sidebar" />
    </div>
  );
}

function NavDrawer({ active, onClose }: { active: AppSection; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="nav-drawer"
      aria-label="导航菜单"
      onClose={onClose}
      onClick={(event) => {
        // 点击遮罩（dialog 自身而非内容）时关闭，与 Esc 行为一致。
        if (event.target === event.currentTarget) dialog.current?.close();
      }}
    >
      <div className="relative h-full">
        <button
          type="button"
          className="toolbar-icon-button is-dark absolute top-2.5 right-3 z-10"
          aria-label="关闭导航菜单"
          onClick={() => dialog.current?.close()}
        >
          ×
        </button>
        <SidebarContent active={active} search={<SearchForm />} />
      </div>
    </dialog>
  );
}

function DashboardIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="size-5 shrink-0">
      <path d="M4 4h7v9H4zM13 4h7v5h-7zM13 11h7v9h-7zM4 15h7v5H4z" />
    </svg>
  );
}

function ChatIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="size-5 shrink-0">
      <path d="M5 5h14v10H9l-4 4z" />
    </svg>
  );
}

function MenuIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="size-5">
      <path d="M4 7h16M4 12h16M4 17h16" />
    </svg>
  );
}
