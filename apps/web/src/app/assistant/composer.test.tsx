import { fireEvent, render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { AssistantComposer } from "./composer";
describe("assistant composer", () => {
  it("sends Enter but not Shift+Enter or IME confirmation", () => {
    const submit = vi.fn();
    render(
      <AssistantComposer
        value="问题"
        onChange={vi.fn()}
        onSubmit={submit}
        onStop={vi.fn()}
        busy={false}
        disabled={false}
      />,
    );
    const input = screen.getByRole("textbox", { name: "消息" });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    expect(submit).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(submit).toHaveBeenCalledTimes(1);
  });
  it("offers real stop during execution", () => {
    const stop = vi.fn();
    render(
      <AssistantComposer
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        onStop={stop}
        busy
        disabled={false}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "停止生成" }));
    expect(stop).toHaveBeenCalledOnce();
  });
});
