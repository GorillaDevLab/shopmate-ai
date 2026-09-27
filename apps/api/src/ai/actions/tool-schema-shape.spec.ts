import { describe, expect, it, vi } from "vitest";

import { CALCULATE_TOOL_DEFINITION } from "../agent/calculate-tool.js";
import { createBusinessOverviewTool } from "../tools/business-overview.tool.js";
import { AgentActionStore } from "./agent-action-store.js";
import {
  createProposeInventoryThresholdTool,
  createProposeMonitoringRuleTool,
  createProposeSaveChartTool,
} from "./propose-action.tools.js";

// OpenAI 兼容的函数调用接口要求参数 schema 顶层是 object；顶层 oneOf/anyOf 会让整次请求失败。
describe("agent tool parameter schemas", () => {
  const store = new AgentActionStore();
  const schemas = {
    calculate: CALCULATE_TOOL_DEFINITION.inputSchema,
    get_business_overview: createBusinessOverviewTool({ get: vi.fn() }).input.jsonSchema,
    propose_inventory_threshold_change: createProposeInventoryThresholdTool(store, {
      findSkuSnapshot: vi.fn(),
    }).input.jsonSchema,
    propose_monitoring_alert: createProposeMonitoringRuleTool(store).input.jsonSchema,
    propose_save_chart: createProposeSaveChartTool(store).input.jsonSchema,
  };

  it.each(Object.entries(schemas))("%s has an object root", (_name, schema) => {
    expect(schema.type).toBe("object");
    expect(schema).not.toHaveProperty("oneOf");
    expect(schema).not.toHaveProperty("anyOf");
  });
});
