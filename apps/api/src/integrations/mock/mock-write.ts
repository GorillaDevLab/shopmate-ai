import {
  TenantIdSchema,
  WriteReceiptSchema,
  type ReadOptions,
  type WriteReceipt,
} from "@shopmate/contracts";
import type { z } from "zod";
import { executeMockRead, MockConnectorError, mockFailure } from "./mock-call.js";

export async function rejectMockWrite(
  schema: z.ZodType,
  command: unknown,
  options: unknown,
  authorize: (options: ReadOptions) => Promise<void>,
): Promise<WriteReceipt> {
  const execution = TenantIdSchema.safeParse(
    command && typeof command === "object"
      ? (command as Record<string, unknown>).executionId
      : undefined,
  );
  // A receipt cannot safely invent the correlation ID of a malformed command.
  if (!execution.success) throw new MockConnectorError("INVALID_INPUT");
  const result = await executeMockRead(options, async (call) => {
    if (!schema.safeParse(command).success) return mockFailure("INVALID_INPUT");
    await authorize(call);
    return mockFailure("UNSUPPORTED");
  });
  return WriteReceiptSchema.parse({
    executionId: execution.data,
    platformRequestId: null,
    receivedAt: new Date().toISOString(),
    outcome: "REJECTED",
    failureCode: result.ok ? "UNSUPPORTED" : result.error.code,
  });
}
