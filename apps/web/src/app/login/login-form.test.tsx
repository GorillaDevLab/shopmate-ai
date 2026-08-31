import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const router = vi.hoisted(() => ({ replace: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

import { LoginForm } from "./login-form";

describe("登录表单", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubGlobal("fetch", vi.fn());
  });

  it("校验必填字段，不发送无效请求", async () => {
    render(<LoginForm />);
    fireEvent.click(screen.getByRole("button", { name: "登录" }));

    expect(await screen.findByText("请输入邮箱地址")).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("登录成功后返回看板并刷新路由", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 200 }));
    render(<LoginForm />);
    fireEvent.change(screen.getByLabelText("邮箱"), { target: { value: "owner@example.com" } });
    fireEvent.change(screen.getByLabelText("密码"), { target: { value: "test-password-123" } });
    fireEvent.click(screen.getByRole("button", { name: "登录" }));

    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/"));
    expect(router.refresh).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledWith(
      "/api/v1/auth/login",
      expect.objectContaining({ method: "POST", credentials: "include" }),
    );
  });

  it("拒绝登录时展示安全的错误提示", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ message: "invalid credentials" }), { status: 401 }),
    );
    render(<LoginForm />);
    fireEvent.change(screen.getByLabelText("邮箱"), { target: { value: "owner@example.com" } });
    fireEvent.change(screen.getByLabelText("密码"), { target: { value: "wrong-password" } });
    fireEvent.click(screen.getByRole("button", { name: "登录" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("邮箱或密码不正确，请重试");
    expect(screen.queryByText("invalid credentials")).not.toBeInTheDocument();
  });
});
