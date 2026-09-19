import { describe, expect, it } from "vitest";
import { DebugReportSchema, sanitizeDebugData } from "./debug-report.js";

describe("debug report privacy", () => {
  it("redacts nested secrets, URL values, credentials, JWTs and card numbers", () => {
    const result = JSON.stringify(
      sanitizeDebugData({
        password: "hidden",
        nested: { accessToken: "hidden" },
        message:
          "https://user:pass@example.com/test?token=hidden&code=hidden#hidden Bearer hidden 4111 1111 1111 1111 person@example.com",
        stack: 'token=hidden eyJhbGc.eyJzdWI.signature {"password":"hidden value"}',
      }),
    );
    for (const secret of ["hidden", "user:pass", "4111", "person@example.com", "eyJhbGc"])
      expect(result).not.toContain(secret);
  });
  it("limits circular structures and rejects oversized or extra fields", () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(() => sanitizeDebugData(cycle)).not.toThrow();
    expect(
      DebugReportSchema.safeParse({
        description: "",
        device: "iPhone",
        info: {},
        logs: [],
        recipient: "other",
      }).success,
    ).toBe(false);
    expect(
      DebugReportSchema.safeParse({
        description: "a".repeat(1001),
        device: "iPhone",
        info: {},
        logs: [],
      }).success,
    ).toBe(false);
  });
});
