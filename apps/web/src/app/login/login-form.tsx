"use client";

import { useRouter } from "next/navigation";
import { FormEvent, useState } from "react";

type FieldErrors = { email?: string; password?: string };

export function LoginForm() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [errors, setErrors] = useState<FieldErrors>({});
  const [requestError, setRequestError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextErrors = validate(email, password);
    setErrors(nextErrors);
    setRequestError(null);
    if (Object.keys(nextErrors).length > 0) return;

    setIsSubmitting(true);
    try {
      const response = await fetch("/api/v1/auth/login", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ email: email.trim(), password }),
      });
      if (!response.ok) {
        setRequestError(response.status === 401 ? "邮箱或密码不正确，请重试。" : "登录服务暂时不可用，请稍后再试。");
        return;
      }
      router.replace("/");
      router.refresh();
    } catch {
      setRequestError("无法连接登录服务，请检查 API 服务后重试。");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <form className="mt-6 space-y-4" onSubmit={handleSubmit} noValidate>
      <div>
        <label className="text-sm font-semibold" htmlFor="login-email">邮箱</label>
        <input
          className="mt-2 min-h-11 w-full rounded-xl border border-app-line bg-app-bg px-3 text-sm outline-none focus:border-brand focus:ring-2 focus:ring-brand/20"
          id="login-email"
          name="email"
          type="email"
          autoComplete="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          aria-invalid={Boolean(errors.email)}
          aria-describedby={errors.email ? "login-email-error" : undefined}
        />
        {errors.email && <p className="mt-1 text-xs text-danger" id="login-email-error">{errors.email}</p>}
      </div>
      <div>
        <label className="text-sm font-semibold" htmlFor="login-password">密码</label>
        <input
          className="mt-2 min-h-11 w-full rounded-xl border border-app-line bg-app-bg px-3 text-sm outline-none focus:border-brand focus:ring-2 focus:ring-brand/20"
          id="login-password"
          name="password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          aria-invalid={Boolean(errors.password)}
          aria-describedby={errors.password ? "login-password-error" : undefined}
        />
        {errors.password && <p className="mt-1 text-xs text-danger" id="login-password-error">{errors.password}</p>}
      </div>
      {requestError && <p className="rounded-xl bg-brand-soft px-3 py-2 text-sm text-danger" role="alert">{requestError}</p>}
      <button
        className="min-h-11 w-full rounded-xl bg-brand px-4 text-sm font-bold text-white transition hover:bg-brand-strong disabled:cursor-not-allowed disabled:opacity-60"
        type="submit"
        disabled={isSubmitting}
        aria-busy={isSubmitting}
      >
        {isSubmitting ? "登录中…" : "登录"}
      </button>
    </form>
  );
}

function validate(email: string, password: string): FieldErrors {
  const errors: FieldErrors = {};
  if (!email.trim()) errors.email = "请输入邮箱地址";
  else if (!/^\S+@\S+\.\S+$/.test(email.trim())) errors.email = "请输入有效的邮箱地址";
  if (!password) errors.password = "请输入密码";
  else if (password.length < 8) errors.password = "密码长度不能少于 8 个字符";
  return errors;
}
