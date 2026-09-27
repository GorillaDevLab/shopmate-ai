"use client";

import { useId, useState, type FormEvent } from "react";

// 与助手草稿、聊天接口 schema 的 content 上限保持一致。
export const TOOLBAR_SEARCH_MAX_LENGTH = 2000;

export function ToolbarSearch({
  onSearch,
  className = "",
}: {
  readonly onSearch: (query: string) => void;
  readonly className?: string;
}) {
  const id = useId();
  const [value, setValue] = useState("");
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const query = value.trim().slice(0, TOOLBAR_SEARCH_MAX_LENGTH);
    if (!query) return;
    onSearch(query);
    setValue("");
  };
  return (
    <form role="search" className={className} onSubmit={submit}>
      <label className="sr-only" htmlFor={id}>
        搜索或提问
      </label>
      <input
        id={id}
        type="search"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        maxLength={TOOLBAR_SEARCH_MAX_LENGTH}
        autoComplete="off"
        placeholder="搜索商品、库存，或直接提问…"
        className="app-input min-h-10 w-full px-3"
      />
    </form>
  );
}

export function UserBadge() {
  return (
    <div className="hidden items-center gap-2 border-l border-app-line pl-3 sm:flex">
      <span aria-hidden="true" className="user-avatar">
        商
      </span>
      <span className="hidden text-sm font-medium xl:inline">商家账号</span>
    </div>
  );
}
