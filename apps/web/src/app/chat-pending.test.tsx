import { act, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ChatPending } from "./chat-pending";

afterEach(() => vi.useRealTimers());
it("持续等待时提示未重试，卸载后清理计时器", () => {
  vi.useFakeTimers();
  const { unmount } = render(<ChatPending />);
  expect(screen.getByRole("status")).toHaveTextContent("正在整理经营数据");
  expect(screen.queryByText(/仍在处理中/)).toBeNull();
  act(() => vi.advanceTimersByTime(15000));
  expect(screen.getByRole("status")).toHaveTextContent("不会自动重试");
  unmount();
  expect(vi.getTimerCount()).toBe(0);
});
