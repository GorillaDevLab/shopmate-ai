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
      router.replace("/login");
      router.refresh();
    } catch {
      setError(true);
      setIsSubmitting(false);
    }
  }

  return (
    <div className="flex items-center gap-2">
      {error && <span className="text-xs text-danger" role="alert">退出失败，请重试</span>}
      <button
        type="button"
        className="min-h-11 rounded-xl border border-app-line bg-app-surface px-3 text-sm font-semibold text-app-text transition hover:bg-brand-soft disabled:cursor-not-allowed disabled:opacity-60"
        onClick={logout}
        disabled={isSubmitting}
      >
        {isSubmitting ? "退出中…" : "退出登录"}
      </button>
    </div>
  );
}
