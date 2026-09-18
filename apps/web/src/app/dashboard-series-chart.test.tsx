import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DashboardSeriesChart } from "./dashboard-series-chart";

const result = {
  kind: "series" as const,
  title: "订单趋势",
  summary: "本周",
  unit: "count" as const,
  points: [
    { date: "2026-09-01", value: 2 },
    { date: "2026-09-02", value: 4 },
    { date: "2026-09-03", value: 6 },
  ],
};

describe("generic series chart", () => {
  it("restores pinned selection after hover and clears it on second click", () => {
    render(<DashboardSeriesChart result={result} />);
    const first = screen.getByRole("button", { name: /9月1日，订单趋势 2/ });
    const second = screen.getByRole("button", { name: /9月2日，订单趋势 4/ });
    fireEvent.click(first);
    fireEvent.mouseEnter(second);
    expect(screen.getByRole("status")).toHaveTextContent("9月2日");
    fireEvent.mouseLeave(second);
    expect(screen.getByRole("status")).toHaveTextContent("9月1日");
    fireEvent.click(first);
    expect(screen.getByRole("status")).toHaveTextContent("9月3日");
  });

  it("shows honest count axis and unit reference", () => {
    render(<DashboardSeriesChart result={result} />);
    expect(screen.getByText("数量")).toBeInTheDocument();
    expect(screen.getByLabelText("数量纵轴")).toHaveTextContent("6");
    expect(screen.queryByText(/¥/)).not.toBeInTheDocument();
  });
});
