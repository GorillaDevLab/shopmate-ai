import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const router = vi.hoisted(() => ({ replace: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

import { LogoutButton } from "./logout-button";

describe("退出登录", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 200 })));
  });

  it("清除会话后跳转到登录页", async () => {
    render(<LogoutButton />);
    fireEvent.click(screen.getByRole("button", { name: "退出登录" }));

    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/login"));
    expect(router.refresh).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledWith(
      "/api/v1/auth/logout",
      expect.objectContaining({ method: "POST", credentials: "include" }),
    );
  });
});
