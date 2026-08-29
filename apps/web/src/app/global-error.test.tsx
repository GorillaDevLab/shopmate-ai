import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import GlobalError from "./global-error";

describe("全局错误页", () => {
  it("提供独立的根级错误边界", () => {
    const errorPagePath = resolve(process.cwd(), "src/app/global-error.tsx");

    expect(existsSync(errorPagePath)).toBe(true);
  });

  it("用中文说明错误并允许重新尝试", () => {
    let retryCount = 0;

    render(
      <GlobalError
        error={new Error("内部错误详情")}
        reset={() => undefined}
        retry={() => {
          retryCount += 1;
        }}
      />,
    );

    expect(screen.getByRole("heading", { name: "页面暂时出了点问题" })).toBeInTheDocument();
    expect(screen.queryByText("内部错误详情")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "重新尝试" }));
    expect(retryCount).toBe(1);
  });
});
