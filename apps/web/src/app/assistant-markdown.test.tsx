import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { AssistantMarkdown } from "./assistant-markdown";

describe("助手 Markdown", () => {
  it("将库存回复渲染为标题、强调和可访问的表格", () => {
    render(
      <AssistantMarkdown
        content={"## 库存风险\n\n**建议关注**\n\n| 商品 | 库存 |\n| --- | --- |\n| 耳机 | 5 |"}
      />,
    );
    expect(screen.getByRole("heading", { name: "库存风险" })).toBeInTheDocument();
    expect(screen.getByText("建议关注").tagName).toBe("STRONG");
    expect(screen.getByRole("table")).toHaveTextContent("耳机");
    expect(screen.getByRole("region", { name: "数据表格" })).toHaveAttribute("tabindex", "0");
  });

  it("不加载远程图片、执行 HTML 或生成危险链接", () => {
    const { container } = render(
      <AssistantMarkdown
        content={
          "<script>alert(1)</script>\n\n![追踪](https://example.com/pixel)\n\n[危险](javascript:alert%281%29)\n\n[来源](https://example.com)"
        }
      />,
    );
    expect(container.querySelector("script, img, iframe")).toBeNull();
    expect(container.querySelector('a[href^="javascript:"]')).toBeNull();
    expect(screen.getByRole("link", { name: "来源" })).toHaveAttribute(
      "rel",
      "noopener noreferrer",
    );
  });
});
