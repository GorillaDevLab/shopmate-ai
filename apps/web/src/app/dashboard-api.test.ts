import { describe, expect, it } from "vitest";

import { DashboardApiError, isAbortError } from "./dashboard-api";

describe("dashboard-api helpers", () => {
  it("keeps the HTTP status on API errors", () => {
    const error = new DashboardApiError("登录已失效，请重新登录", 401);
    expect(error).toMatchObject({ name: "DashboardApiError", status: 401 });
  });

  it("recognises only real abort errors", () => {
    expect(isAbortError(new DOMException("aborted", "AbortError"))).toBe(true);
    expect(isAbortError(new Error("AbortError"))).toBe(false);
  });
});
