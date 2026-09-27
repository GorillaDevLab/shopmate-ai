import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { render } from "../test/assistant-render";

const navigation = vi.hoisted(() => ({
  redirect: vi.fn(),
  push: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/",
  useRouter: () => ({ push: navigation.push, replace: vi.fn(), refresh: vi.fn() }),
  redirect: navigation.redirect,
}));
vi.mock("./analytics/analytics-api", async () => {
  const { overviewFixture } = await import("./analytics/analytics-fixture");
  return {
    fetchAnalyticsOverview: vi.fn(async (asOfDate: string, startDate: string) => ({
      ...overviewFixture(),
      period: { startDate, endDate: asOfDate, days: 14 },
    })),
  };
});
vi.mock("./analytics/analytics-layout-api", async () => {
  const { DEFAULT_ANALYTICS_LAYOUT } = await import("@shopmate/contracts");
  return {
    fetchAnalyticsLayout: vi.fn(async () => ({
      layout: DEFAULT_ANALYTICS_LAYOUT,
      revision: 0,
      updatedAt: null,
    })),
    saveAnalyticsLayout: vi.fn(),
  };
});

import RootLayout, { metadata } from "./layout";
import Home from "./page";
import AnalyticsRedirect from "./analytics/page";

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("[]", { status: 200 })),
  );
});

describe("中文应用基础", () => {
  it("首页就是经营分析，侧栏只保留一个经营分析入口", async () => {
    render(<Home />);
    expect(await screen.findByRole("region", { name: "经营总览" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "经营分析" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "经营分析" })).toHaveAttribute("href", "/");
    expect(screen.queryByRole("link", { name: "经营看板" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "编辑看板" })).toBeEnabled();
  });

  it("旧的 /analytics 地址跳转到首页", () => {
    AnalyticsRedirect();
    expect(navigation.redirect).toHaveBeenCalledWith("/");
  });

  it("声明中文页面语言与元数据", () => {
    const markup = renderToStaticMarkup(
      <RootLayout>
        <main>内容</main>
      </RootLayout>,
    );

    expect(markup).toContain('lang="zh-CN"');
    expect(markup).toContain('data-theme="purple"');
    expect(metadata.title).toBe("ShopMate AI｜智能经营助手");
    expect(metadata.description).toBe("面向电商商家的中文经营看板，集中查看销售、商品与库存信息。");
  });

  it("提供浏览器应用图标", () => {
    expect(existsSync(resolve(process.cwd(), "src/app/icon.svg"))).toBe(true);
  });
});
