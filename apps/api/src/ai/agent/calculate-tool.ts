import type { JsonObject, LLMToolDefinition } from "@shopmate/contracts";
import { z } from "zod";

import { extractAnswerNumbers, type NumericGrounding } from "./numeric-grounding.js";

export const CALCULATE_TOOL_NAME = "calculate";

const OPERATIONS = ["percent_change", "share", "difference", "sum", "average", "ratio"] as const;
type Operation = (typeof OPERATIONS)[number];

const CalculateInputSchema = z.strictObject({
  operation: z.enum(OPERATIONS),
  values: z.array(z.number().finite()).min(1).max(100),
});

const OPERATION_HINT: Record<Operation, string> = {
  percent_change: "[本期, 上期] → 变化百分比",
  share: "[部分, 整体] → 占比百分比",
  difference: "[a, b] → a − b",
  sum: "[…] → 合计",
  average: "[…] → 平均值",
  ratio: "[a, b] → a ÷ b（倍数）",
};

export const CALCULATE_TOOL_DEFINITION: LLMToolDefinition = {
  name: CALCULATE_TOOL_NAME,
  description: [
    "对本轮已查到的经营数字做计算。需要在回答里给出环比、占比、差额、合计、平均或倍数时，先用此工具计算再引用结果。",
    "values 中的每个数字都必须原样来自本轮工具结果（金额字段以 Minor 结尾的单位是分，可除以 100 后以元传入），否则会被拒绝。",
    `operation：${OPERATIONS.map((operation) => `${operation} ${OPERATION_HINT[operation]}`).join("；")}。`,
  ].join(""),
  inputSchema: z.toJSONSchema(CalculateInputSchema) as JsonObject,
};

export type CalculateOutput =
  | {
      readonly status: "ok";
      readonly data: {
        readonly operation: Operation;
        readonly values: readonly number[];
        readonly result: number;
      };
    }
  | {
      readonly status: "error";
      readonly error: {
        readonly code: string;
        readonly message: string;
        readonly retryable: boolean;
      };
    };

/** 输入必须已有依据，防止先编一个数字再“计算”把它洗成证据。 */
export function runCalculate(args: unknown, grounding: NumericGrounding): CalculateOutput {
  const parsed = CalculateInputSchema.safeParse(args);
  if (!parsed.success) return failure("INVALID_INPUT", "计算参数格式不正确。");
  const { operation, values } = parsed.data;
  const ungrounded = values.filter((value) => !isGroundedInput(value, grounding));
  if (ungrounded.length > 0) {
    return failure(
      "UNGROUNDED_INPUT",
      `这些数字不在本轮查询结果中：${ungrounded.join("、")}。请先用查询工具取得数据。`,
    );
  }
  const result = compute(operation, values);
  if (result === null || !Number.isFinite(result)) {
    return failure("INVALID_INPUT", `${OPERATION_HINT[operation]} 的输入数量不对，或除数为 0。`);
  }
  return { status: "ok", data: { operation, values, result: Number(result.toFixed(4)) } };
}

function isGroundedInput(value: number, grounding: NumericGrounding): boolean {
  const [number] = extractAnswerNumbers(String(Math.abs(value)));
  return number !== undefined && grounding.isGrounded({ ...number, suffix: "" });
}

function compute(operation: Operation, values: readonly number[]): number | null {
  const [a, b] = values;
  const pair = values.length === 2 && b !== undefined;
  switch (operation) {
    case "percent_change":
      return pair && b !== 0 ? ((a - b) / Math.abs(b)) * 100 : null;
    case "share":
      return pair && b !== 0 ? (a / b) * 100 : null;
    case "ratio":
      return pair && b !== 0 ? a / b : null;
    case "difference":
      return pair ? a - b : null;
    case "sum":
      return values.reduce((total, value) => total + value, 0);
    case "average":
      return values.reduce((total, value) => total + value, 0) / values.length;
  }
}

function failure(code: string, message: string): CalculateOutput {
  return { status: "error", error: { code, message, retryable: false } };
}
