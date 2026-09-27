"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

const BUTTON_CLASS = {
  default:
    "min-h-11 rounded-lg border border-app-line bg-app-surface px-3 text-sm font-medium text-app-text transition-colors hover:bg-gray-50 active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-60",
  sidebar: "sidebar-action disabled:cursor-not-allowed disabled:opacity-60",
} as const;

export function LogoutButton({ variant = "default" }: { variant?: keyof typeof BUTTON_CLASS }) {
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
      router.replace("/login");
      router.refresh();
    } catch {
      setError(true);
      setIsSubmitting(false);
    }
  }

  return (
    <div className={variant === "sidebar" ? "grid gap-1" : "flex items-center gap-2"}>
      {error && (
        <span
          className={variant === "sidebar" ? "px-3 text-xs text-red-300" : "text-xs text-danger"}
          role="alert"
        >
          退出失败，请重试
        </span>
      )}
      <button
        type="button"
        className={BUTTON_CLASS[variant]}
        onClick={logout}
        disabled={isSubmitting}
      >
        {variant === "sidebar" && <LogoutIcon />}
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
