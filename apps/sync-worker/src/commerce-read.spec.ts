import { describe, expect, it, vi } from "vitest";
import {
  SourceStorageError,
  type BoundSourceReadPort,
} from "@shopmate/database/mock-platform-read";
import { CommerceReadPort } from "./commerce-read.js";

const options = () => ({
  requestId: "read-a",
  deadlineAt: new Date(Date.now() + 5000).toISOString(),
});
const request = {
  kind: "PRODUCT",
  requestedUntil: "2026-01-01T00:00:00.000Z",
  businessNow: "2026-01-01T00:00:00.000Z",
  limit: 1,
  contextHash: "a".repeat(64),
};
function reader(read: BoundSourceReadPort["read"]): BoundSourceReadPort {
  return { read, refreshCheckpoint: async () => null, findPublication: async () => null };
}
describe("commerce restricted reader", () => {
  it.each([
    ["SOURCE_INPUT", "INVALID_INPUT"],
    ["SOURCE_INTEGRITY", "INVALID_RESPONSE"],
    ["SOURCE_ABORTED", "ABORTED"],
    ["SOURCE_DEADLINE", "TIMEOUT"],
    ["SOURCE_STORAGE", "TEMPORARY"],
    ["SOURCE_CONFIGURATION", "INVALID_RESPONSE"],
    ["SOURCE_CREDENTIALS", "INVALID_RESPONSE"],
  ] as const)("maps %s to %s", async (source, code) => {
    const port = new CommerceReadPort(
      reader(async () => {
        throw new SourceStorageError(source);
      }),
    );
    await expect(port.read(request, options())).rejects.toMatchObject({ code });
  });
  it("keeps unknown publication null and removes connector-only request id", async () => {
    const read = vi.fn<BoundSourceReadPort["read"]>(async () => null);
    expect(await new CommerceReadPort(reader(read)).read(request, options())).toBeNull();
    expect(read.mock.calls[0]?.[1]).not.toHaveProperty("requestId");
  });
});
