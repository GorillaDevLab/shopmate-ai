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

  it("renders zero bars at the shared baseline with zero height", () => {
    const { container } = render(
      <DashboardSeriesChart
        view="bar"
        result={{
          ...result,
          points: [
            { date: "2026-09-01", value: 0 },
            { date: "2026-09-02", value: 6 },
          ],
        }}
      />,
    );
    const zeroBar = container.querySelector('rect[data-date="2026-09-01"]');
    expect(zeroBar).toHaveAttribute("y", "162");
    expect(zeroBar).toHaveAttribute("height", "0");
    expect(screen.getByLabelText("数量纵轴").querySelector("span:last-child")).toHaveStyle({
      top: "90%",
    });
  });

  it("physically clears removed selection and does not resurrect it", () => {
    const { rerender } = render(<DashboardSeriesChart result={result} />);
    fireEvent.click(screen.getByRole("button", { name: /9月1日/ }));
    rerender(<DashboardSeriesChart result={{ ...result, points: result.points.slice(1) }} />);
    rerender(<DashboardSeriesChart result={result} />);
    expect(screen.getByRole("status")).toHaveTextContent("9月3日");
  });

  it("dense selection offers reset to latest date", () => {
    const points = Array.from({ length: 30 }, (_, index) => ({
      date: `2026-08-${String(index + 1).padStart(2, "0")}`,
      value: index,
    }));
    render(<DashboardSeriesChart result={{ ...result, points }} />);
    fireEvent.change(screen.getByRole("slider"), { target: { value: "3" } });
    expect(screen.getByRole("status")).toHaveTextContent("8月4日");
    fireEvent.click(screen.getByRole("button", { name: "重置为最新日期" }));
    expect(screen.getByRole("status")).toHaveTextContent("8月30日");
  });

  it("uses the result title in generic chart image aria", () => {
    render(<DashboardSeriesChart result={result} />);
    expect(screen.getByRole("img", { name: "订单趋势图" })).toBeInTheDocument();
  });
});
