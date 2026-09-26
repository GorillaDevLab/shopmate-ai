import { describe, expect, it } from "vitest";
import { AssistantRunEventSchema, AssistantRunRequestSchema } from "./assistant-run.schema.js";
describe("assistant run protocol", () => {
  it("rejects tenant injection and unbounded ids", () => {
    const body = { requestId: "request-123", message: { role: "user", content: "经营怎么样" } };
    expect(AssistantRunRequestSchema.safeParse(body).success).toBe(true);
    expect(AssistantRunRequestSchema.safeParse({ ...body, merchantId: "other" }).success).toBe(
      false,
    );
    expect(
      AssistantRunRequestSchema.safeParse({ ...body, requestId: "x".repeat(129) }).success,
    ).toBe(false);
  });
  it("validates terminal messages and never accepts raw reasoning", () => {
    expect(
      AssistantRunEventSchema.safeParse({
        type: "completed",
        requestId: "r",
        reply: { role: "assistant", content: "查询完成" },
      }).success,
    ).toBe(true);
    expect(
      AssistantRunEventSchema.safeParse({
        type: "completed",
        requestId: "r",
        reply: { role: "assistant", content: "" },
      }).success,
    ).toBe(false);
    expect(
      AssistantRunEventSchema.safeParse({ type: "thinking", requestId: "r", content: "secret" })
        .success,
    ).toBe(false);
  });
});
