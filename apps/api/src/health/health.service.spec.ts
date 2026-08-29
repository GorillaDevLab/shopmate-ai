import { afterEach, describe, expect, it, vi } from "vitest";
import { HealthService } from "./health.service.js";

describe("HealthService", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("返回稳定的结构化中文健康结果", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-30T00:00:00.000Z"));

    expect(new HealthService().check()).toEqual({
      status: "ok",
      service: "shopmate-api",
      message: "服务运行正常",
      timestamp: "2026-08-30T00:00:00.000Z",
    });
  });
});
