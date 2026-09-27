import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ToolbarSearch, UserBadge } from "./toolbar-search";

describe("ToolbarSearch 顶部搜索", () => {
  it("提交去除首尾空白的内容后清空输入框", () => {
    const onSearch = vi.fn();
    render(<ToolbarSearch onSearch={onSearch} />);
    const input = screen.getByRole("searchbox", { name: "搜索或提问" });

    fireEvent.change(input, { target: { value: "  最近哪些商品需要补货？ " } });
    fireEvent.submit(screen.getByRole("search"));

    expect(onSearch).toHaveBeenCalledWith("最近哪些商品需要补货？");
    expect(input).toHaveValue("");
  });

  it("空白内容不会触发搜索", () => {
    const onSearch = vi.fn();
    render(<ToolbarSearch onSearch={onSearch} />);

    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "   " } });
    fireEvent.submit(screen.getByRole("search"));

    expect(onSearch).not.toHaveBeenCalled();
  });

  it("限制输入长度与聊天接口上限一致", () => {
    render(<ToolbarSearch onSearch={vi.fn()} />);
    expect(screen.getByRole("searchbox")).toHaveAttribute("maxlength", "2000");
  });

  it("用户信息以文字呈现账号名称", () => {
    render(<UserBadge />);
    expect(screen.getByText("商家账号")).toBeInTheDocument();
  });
});
