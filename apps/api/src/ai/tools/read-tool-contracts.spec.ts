import {
  AI_READ_TOOL_NAMES,
  GetBestSellersTool,
  GetInventoryRisksTool,
  GetProductDetailsTool,
  GetProductPerformanceTool,
  GetSalesSummaryTool,
  GetSalesTrendTool,
} from "@shopmate/contracts";
import { describe, expect, it } from "vitest";

import { ToolRegistry } from "./tool-registry.js";

const emptyResult = {
  status: "empty" as const,
  reason: "NO_DATA" as const,
  message: "当前查询范围内没有数据。",
};

describe("AI 读取工具与 ToolRegistry 的契约边界", () => {
  it("六个只读工具 Schema 均可直接注册", () => {
    const registry = new ToolRegistry({ allowedToolNames: AI_READ_TOOL_NAMES });

    registry.register({ ...GetProductDetailsTool, handler: () => emptyResult });
    registry.register({ ...GetInventoryRisksTool, handler: () => emptyResult });
    registry.register({ ...GetSalesSummaryTool, handler: () => emptyResult });
    registry.register({ ...GetBestSellersTool, handler: () => emptyResult });
    registry.register({ ...GetSalesTrendTool, handler: () => emptyResult });
    registry.register({ ...GetProductPerformanceTool, handler: () => emptyResult });

    expect(registry.listDefinitions().map((definition) => definition.name)).toEqual(
      AI_READ_TOOL_NAMES,
    );
  });
});
