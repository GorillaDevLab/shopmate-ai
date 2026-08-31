import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import RootLayout, { metadata } from "./layout";
import Home, { Dashboard } from "./page";

describe("中文应用基础", () => {
  it("展示四项经营指标而非库存占位指标", () => {
    render(<Home />);
    for (const name of ["今日销售额", "今日订单", "今日销量", "客单价"]) {
      expect(screen.getByRole("article", { name })).toBeInTheDocument();
    }
    expect(screen.getByText("¥44.34")).toBeInTheDocument();
    expect(screen.queryByText("库存健康度")).not.toBeInTheDocument();
  });
  it("展示经营 Dashboard 的核心区域", () => {
    render(<Home />);

    expect(screen.getByRole("heading", { name: "今天的经营，一眼看清" })).toBeInTheDocument();
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

  it("明确展示演示数据，不伪装成实时同步", () => {
    render(<Home />);
    expect(screen.getByText("演示数据预览")).toBeInTheDocument();
    expect(screen.queryByText("数据更新于刚刚")).not.toBeInTheDocument();
    expect(screen.queryByText("周一，早上好")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /查看全部提醒/ })).not.toBeInTheDocument();
    expect(screen.getByText("已售罄")).toBeInTheDocument();
    expect(screen.getByText("暂无销量，无法估算")).toBeInTheDocument();
  });

  it("展示预览趋势并标注模拟数据来源", () => {
    render(<Home />);
    expect(screen.getByRole("img", { name: "近七日销售趋势图（演示数据）" })).toBeInTheDocument();
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
