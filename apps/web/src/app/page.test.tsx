import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import RootLayout, { metadata } from "./layout";
import Home, { Dashboard } from "./page";

describe("中文应用基础", () => {
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
    expect(metadata.title).toBe("ShopMate AI｜智能购物助手");
    expect(metadata.description).toBe("用 AI 整理商品信息，做出更轻松的购物决策。");
  });

  it("提供浏览器应用图标", () => {
    expect(existsSync(resolve(process.cwd(), "src/app/icon.svg"))).toBe(true);
  });
});

describe("Dashboard 三态", () => {
  it("加载时显示骨架提示", () => {
    render(<Dashboard state="loading" />);
    expect(screen.getByText("正在整理你的经营数据…")).toBeInTheDocument();
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
