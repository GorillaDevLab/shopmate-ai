import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }) }));

import RootLayout, { metadata } from "./layout";
import { Dashboard } from "./page";
import { dashboardResponsePreview } from "./dashboard-data";

const readyDashboard = <Dashboard state="ready" data={dashboardResponsePreview} />;

describe("中文应用基础", () => {
  it("展示四项经营指标而非库存占位指标", () => {
    render(readyDashboard);
    for (const name of ["近 7 天销售额", "近 7 天订单", "近 7 天销量", "近 7 天客单价"]) {
      expect(screen.getByRole("article", { name })).toBeInTheDocument();
    }
    expect(screen.getByText("¥44.34")).toBeInTheDocument();
    expect(screen.queryByText("库存健康度")).not.toBeInTheDocument();
  });
  it("展示经营 Dashboard 的核心区域", () => {
    render(readyDashboard);

    expect(screen.getByRole("heading", { name: "近 7 天经营，一眼看清" })).toBeInTheDocument();
    expect(screen.getByText("ShopMate AI")).toBeInTheDocument();
    expect(screen.getByText("经营总览")).toBeInTheDocument();
    expect(screen.getByText("热销商品")).toBeInTheDocument();
    expect(screen.getByText("库存提醒")).toBeInTheDocument();
  });

  it("声明中文页面语言与元数据", () => {
    const markup = renderToStaticMarkup(
      <RootLayout>
        <main>内容</main>
      </RootLayout>,
    );

    expect(markup).toContain('lang="zh-CN"');
    expect(metadata.title).toBe("ShopMate AI｜智能经营助手");
    expect(metadata.description).toBe("面向电商商家的中文经营看板，集中查看销售、商品与库存信息。");
  });

  it("提供浏览器应用图标", () => {
    expect(existsSync(resolve(process.cwd(), "src/app/icon.svg"))).toBe(true);
  });

  it("明确展示 Analytics API 的统计日期", () => {
    render(readyDashboard);
    expect(screen.getByText("数据来自 Analytics API")).toBeInTheDocument();
    expect(screen.getByText("统计截至 2026年8月31日")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /查看全部提醒/ })).not.toBeInTheDocument();
    expect(screen.getByText("已售罄")).toBeInTheDocument();
    expect(screen.getByText("暂无销量，无法估算")).toBeInTheDocument();
  });

  it("展示真实日期与金额的响应式趋势图", () => {
    render(readyDashboard);
    expect(screen.getByRole("img", { name: "近 7 天销售趋势图" })).toBeInTheDocument();
  });
});

describe("Dashboard 三态", () => {
  it.each(["loading", "empty", "error"] as const)("%s 时不残留演示指标", (state) => {
    render(<Dashboard state={state} />);
    expect(screen.queryByText("¥12,680.00")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "热销商品" })).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toBeInTheDocument();
  });
  it("加载时显示骨架提示", () => {
    render(<Dashboard state="loading" />);
    expect(screen.getByText("正在整理你的经营数据…")).toBeInTheDocument();
    expect(screen.getAllByText("正在加载指标")).toHaveLength(4);
  });

  it("空数据时给出下一步提示", () => {
    render(<Dashboard state="empty" />);
    expect(screen.getByText("还没有经营数据")).toBeInTheDocument();
    expect(screen.getByText("导入第一批商品后，这里会自动生成经营概览。")).toBeInTheDocument();
  });

  it("错误时说明可以重试", () => {
    render(<Dashboard state="error" />);
    expect(screen.getByText("数据暂时加载失败")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重新加载" })).toBeInTheDocument();
  });
});
