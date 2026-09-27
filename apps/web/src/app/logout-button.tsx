"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function LogoutButton() {
  const router = useRouter();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState(false);

  async function logout() {
    setIsSubmitting(true);
    setError(false);
    try {
      const response = await fetch("/api/v1/auth/logout", {
        method: "POST",
        credentials: "include",
        headers: { Accept: "application/json" },
      });
      if (!response.ok) throw new Error("logout failed");
      window.dispatchEvent(new Event("shopmate:logout"));
      router.replace("/login");
      router.refresh();
    } catch {
      setError(true);
      setIsSubmitting(false);
    }
  }

  return (
    <div className="flex items-center gap-2">
      {error && (
        <span className="text-xs text-danger" role="alert">
          退出失败，请重试
        </span>
      )}
      <button
        type="button"
        className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-app-line bg-app-surface px-3 text-sm font-medium text-app-text transition-colors hover:bg-app-bg active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-60"
        onClick={logout}
        disabled={isSubmitting}
      >
        <LogoutIcon />
        {isSubmitting ? "退出中…" : "退出登录"}
      </button>
    </div>
  );
}

function LogoutIcon() {
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
      <path d="M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4M9 16l-4-4 4-4M5 12h10" />
    </svg>
  );
}
