import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import RootLayout, { metadata } from "./layout";
import Home from "./page";

describe("中文应用基础", () => {
  it("展示 ShopMate AI 的中文价值主张", () => {
    render(<Home />);

    expect(
      screen.getByRole("heading", { name: "让每一次购物决策更简单" }),
    ).toBeInTheDocument();
    expect(screen.getByText("ShopMate AI")).toBeInTheDocument();
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
