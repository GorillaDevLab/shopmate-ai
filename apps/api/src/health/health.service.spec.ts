import { afterEach, describe, expect, it, vi } from "vitest";

describe("HealthService", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("返回稳定的结构化中文健康结果", async () => {
    const healthModule = await import("./health.service.js").catch(() => null);

    expect(healthModule).not.toBeNull();
    if (!healthModule) return;

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-30T00:00:00.000Z"));

    expect(new healthModule.HealthService().check()).toEqual({
      status: "ok",
      service: "shopmate-api",
      message: "服务运行正常",
      timestamp: "2026-08-30T00:00:00.000Z",
    });
  });
});
