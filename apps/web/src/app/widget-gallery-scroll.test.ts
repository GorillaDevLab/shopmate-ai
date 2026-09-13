import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync("src/app/globals.css", "utf8");
const rule = (selector: string) => css.slice(css.indexOf(`${selector} {`)).split("}")[0];

describe("组件库滚动布局", () => {
  it("桌面端也限制高度并提供正文滚动，保留固定标题", () => {
    expect(rule(".widget-gallery-shell")).toContain("max-height: calc(100dvh - 48px)");
    expect(rule(".widget-gallery-shell")).toContain("grid-template-rows: auto minmax(0, 1fr)");
    expect(rule(".widget-gallery-body")).toContain("min-height: 0");
    expect(rule(".widget-gallery-body")).toContain("overflow-y: auto");
    expect(rule(".widget-gallery-body")).toContain("overscroll-behavior: contain");
  });

  it("长预览从顶部开始，避免居中溢出后无法访问", () => {
    expect(rule(".widget-gallery-preview")).toContain("align-content: start");
  });
});
