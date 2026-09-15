import { act, render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { DashboardInsightQuery, DashboardInsightResult } from "@shopmate/contracts";
import { DashboardInsightCard } from "./dashboard-insight-card";
import { executeDashboardInsight } from "./dashboard-insight-api";

vi.mock("./dashboard-insight-api", () => ({ executeDashboardInsight: vi.fn() }));

const query: DashboardInsightQuery = {
  dataset: "sales",
  metric: "revenue",
  aggregation: "sum",
  groupBy: "product",
  dateRange: { start: "2026-08-01", end: "2026-08-31" },
  filters: [],
  order: "desc",
  limit: 8,
  visualization: "pie",
};
const result: DashboardInsightResult = {
  kind: "pie",
  title: "销售占比",
  summary: "近30天",
  unit: "currencyMinor",
  slices: [{ key: "p", label: "商品", value: 100 }],
};
beforeEach(() => vi.resetAllMocks());

it("复用预览且相同查询对象重建不重复请求", () => {
  const view = render(<DashboardInsightCard query={query} initialResult={result} />);
  view.rerender(<DashboardInsightCard query={{ ...query }} initialResult={result} />);
  expect(screen.getByRole("heading", { name: "销售占比" })).toBeInTheDocument();
  expect(executeDashboardInsight).not.toHaveBeenCalled();
});

it("查询改变必须重新读取数据，不能沿用旧预览", async () => {
  vi.mocked(executeDashboardInsight).mockResolvedValue({ ...result, title: "新范围占比" });
  const view = render(<DashboardInsightCard query={query} initialResult={result} />);
  view.rerender(<DashboardInsightCard query={{ ...query, limit: 5 }} initialResult={result} />);
  expect(await screen.findByRole("heading", { name: "新范围占比" })).toBeInTheDocument();
  expect(executeDashboardInsight).toHaveBeenCalledTimes(1);
});

it("旧查询迟到的结果不能覆盖新查询", async () => {
  let resolveOld!: (result: DashboardInsightResult) => void;
  vi.mocked(executeDashboardInsight)
    .mockReturnValueOnce(
      new Promise((resolve) => {
        resolveOld = resolve;
      }),
    )
    .mockResolvedValueOnce({ ...result, title: "新范围占比" });
  const view = render(<DashboardInsightCard query={query} />);
  view.rerender(<DashboardInsightCard query={{ ...query, limit: 5 }} />);
  await screen.findByRole("heading", { name: "新范围占比" });
  await act(async () => resolveOld(result));
  expect(screen.getByRole("heading", { name: "新范围占比" })).toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: "销售占比" })).not.toBeInTheDocument();
});
