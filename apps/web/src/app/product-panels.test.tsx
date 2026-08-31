import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { DashboardHotProduct, DashboardInventoryAlert } from "@shopmate/contracts";
import { HotProductsPanel } from "./hot-products-panel";
import { LowInventoryPanel } from "./low-inventory-panel";

const product: DashboardHotProduct = {
  rank: 7,
  name: "台灯",
  sku: "LAMP-WHITE",
  sold: 1286,
  salesMinor: 30001,
};
const alert: DashboardInventoryAlert = {
  name: "台灯",
  sku: "LAMP-WHITE",
  inventory: 12,
  recentSold: 28,
  forecast: { status: "estimated", days: 1.5 },
};

describe("热销列表", () => {
  it("显示上游排名和顺序，不按数值重新排名", () => {
    render(
      <HotProductsPanel
        items={[product, { ...product, rank: 2, sku: "LAMP-BLACK", sold: 2000 }]}
      />,
    );
    const rows = screen.getAllByRole("listitem");
    expect(within(rows[0]).getByText("第 7 名")).toBeInTheDocument();
    expect(within(rows[1]).getByText("第 2 名")).toBeInTheDocument();
    expect(screen.getByText("SKU：LAMP-WHITE")).toBeInTheDocument();
    expect(screen.getByText("1,286 件")).toBeInTheDocument();
    expect(screen.getAllByText("¥300.01")).toHaveLength(2);
  });
  it("零值正常展示，未知值明确标注", () => {
    const { rerender } = render(
      <HotProductsPanel items={[{ ...product, sold: 0, salesMinor: 0 }]} />,
    );
    expect(screen.getByText("0 件")).toBeInTheDocument();
    expect(screen.getByText("¥0.00")).toBeInTheDocument();
    rerender(<HotProductsPanel items={[{ ...product, sold: null, salesMinor: null }]} />);
    expect(screen.getAllByText("暂无数据")).toHaveLength(2);
    expect(screen.queryByText("¥0.00")).not.toBeInTheDocument();
  });
});

describe("库存预测", () => {
  it("只格式化上游天数，不使用库存和销量重新计算", () => {
    render(<LowInventoryPanel items={[alert]} />);
    expect(screen.getByText("预计约 1.5 天售罄")).toBeInTheDocument();
    expect(screen.getByText("剩余 12 件")).toBeInTheDocument();
    expect(screen.getByText("近 7 天销量：28 件")).toBeInTheDocument();
  });
  it.each([
    [{ ...alert, inventory: 0, forecast: { status: "out_of_stock" } }, "已售罄"],
    [{ ...alert, recentSold: 0, forecast: { status: "no_sales" } }, "暂无销量，无法估算"],
    [
      { ...alert, recentSold: null, forecast: { status: "insufficient_data" } },
      "数据不足，无法估算",
    ],
    [{ ...alert, forecast: { status: "estimated", days: 0.001 } }, "预计不足 0.1 天售罄"],
  ] as const)("特殊状态不伪造天数 %#", (item, text) => {
    render(<LowInventoryPanel items={[item]} />);
    expect(screen.getByText(text)).toBeInTheDocument();
    expect(screen.queryByText(/预计.*0 天|Infinity|NaN/)).not.toBeInTheDocument();
  });
});

describe.each(["hot", "inventory"] as const)("%s 列表状态", (kind) => {
  const panel = (state: "ready" | "loading" | "empty" | "error", empty = false) =>
    kind === "hot" ? (
      <HotProductsPanel items={empty ? [] : [product]} state={state} />
    ) : (
      <LowInventoryPanel items={empty ? [] : [alert]} state={state} />
    );
  it.each(["loading", "empty", "error"] as const)("%s 不残留旧条目", (state) => {
    render(panel(state));
    expect(screen.queryByText("SKU：LAMP-WHITE")).not.toBeInTheDocument();
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toBeInTheDocument();
    expect(screen.getByRole("region")).toHaveAttribute("aria-busy", String(state === "loading"));
  });
  it("空数组显示空态", () => {
    render(panel("ready", true));
    expect(screen.getByRole("status")).toHaveTextContent(/暂无/);
  });
  it("加载后可恢复真实条目", () => {
    const { rerender } = render(panel("loading"));
    rerender(panel("ready"));
    expect(screen.getByText("SKU：LAMP-WHITE")).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});

it("两个区域状态相互独立", () => {
  render(
    <>
      <HotProductsPanel items={[product]} state="error" />
      <LowInventoryPanel items={[alert]} />
    </>,
  );
  expect(screen.getByText("热销商品加载失败")).toBeInTheDocument();
  expect(screen.getByText("预计约 1.5 天售罄")).toBeInTheDocument();
});
