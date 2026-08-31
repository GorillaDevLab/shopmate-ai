import { fireEvent, render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { DashboardRangeControls } from "./dashboard-range";

beforeAll(() => {
  // jsdom does not implement native modal dialogs; real focus/escape behavior is browser-tested.
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
    this.dispatchEvent(new Event("close"));
  };
});
describe("自选时段", () => {
  it("编辑不请求，非法范围被拒绝，应用后提交整个区间", () => {
    const onChange = vi.fn();
    render(
      <DashboardRangeControls
        latestDate="2026-08-31"
        value={{ kind: "7", endDate: "2026-08-31" }}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "自选时段" }));
    fireEvent.change(screen.getByLabelText("开始日期"), { target: { value: "2026-07-01" } });
    fireEvent.click(screen.getByRole("button", { name: "应用时段" }));
    expect(screen.getByRole("alert")).toHaveTextContent("最多 31 天");
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("开始日期"), { target: { value: "2026-08-10" } });
    fireEvent.change(screen.getByLabelText("结束日期"), { target: { value: "2026-08-15" } });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "应用时段" }));
    expect(onChange).toHaveBeenCalledWith({
      kind: "custom",
      startDate: "2026-08-10",
      endDate: "2026-08-15",
    });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  it("取消不会改变已应用范围", () => {
    const onChange = vi.fn();
    render(
      <DashboardRangeControls
        latestDate="2026-08-31"
        value={{ kind: "30", startDate: "2026-08-02", endDate: "2026-08-31" }}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "自选时段" }));
    fireEvent.change(screen.getByLabelText("开始日期"), { target: { value: "2026-08-12" } });
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    fireEvent.click(screen.getByRole("button", { name: "自选时段" }));
    expect(screen.getByLabelText("开始日期")).toHaveValue("2026-08-02");
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "近 30 天" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });
});
