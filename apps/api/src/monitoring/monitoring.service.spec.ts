import { ConflictException, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createAuthContext } from "../auth/contracts/index.js";
import { MonitoringService } from "./monitoring.service.js";

const context = createAuthContext({ userId: "user-1", merchantId: "merchant-1", permissions: [] });
const definition = {
  kind: "salesThreshold",
  metric: "revenue",
  operator: "below",
  threshold: 100_000,
  window: "30d",
  frequency: "daily",
} as const;
const now = new Date("2026-09-03T00:00:00.000Z");

describe("MonitoringService", () => {
  const repository = repositoryStub();
  const evaluator = { evaluate: vi.fn() };
  const service = new MonitoringService(repository, evaluator, () => now);

  beforeEach(() => {
    vi.clearAllMocks();
    repository.countActive.mockResolvedValue(0);
  });

  it("第 11 条启用规则返回冲突且不写入", async () => {
    repository.countActive.mockResolvedValue(10);
    await expect(service.create(context, { name: "销售预警", definition })).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(repository.createRule).not.toHaveBeenCalled();
  });

  it("创建时只使用认证上下文和规范化定义", async () => {
    repository.createRule.mockResolvedValue(ruleRecord());
    await service.create(context, { name: " 销售预警 ", definition });
    expect(repository.createRule).toHaveBeenCalledWith(
      context,
      "销售预警",
      definition,
      new Date("2026-09-04T00:00:00.000Z"),
    );
  });

  it("执行规则后用稳定指纹完成事务", async () => {
    repository.findRule.mockResolvedValue(ruleRecord());
    repository.completeRun.mockResolvedValue(1);
    evaluator.evaluate.mockResolvedValue({
      matched: true,
      periodStart: "2026-08-05T00:00:00.000Z",
      periodEnd: "2026-09-03T23:59:59.999Z",
      matches: [
        {
          resourceType: "MERCHANT",
          resourceId: "merchant-1",
          title: "销售额达到监听条件",
          message: "销售额低于阈值",
          severity: "WARNING",
        },
      ],
    });

    await expect(service.runRule(context, "rule-1")).resolves.toMatchObject({
      createdNotifications: 1,
    });
    expect(repository.completeRun).toHaveBeenCalledWith(
      context,
      "rule-1",
      now,
      new Date("2026-09-04T00:00:00.000Z"),
      [expect.objectContaining({ fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u) })],
    );
  });

  it("同步最多读取 10 条到期规则并记录失败", async () => {
    repository.findDueRules.mockResolvedValue([ruleRecord()]);
    evaluator.evaluate.mockRejectedValue(new Error("database secret"));

    await expect(service.sync(context)).resolves.toEqual({
      evaluatedRules: 1,
      createdNotifications: 0,
      failedRules: 1,
    });
    expect(repository.findDueRules).toHaveBeenCalledWith(context, now, 10);
    expect(repository.failRun).toHaveBeenCalledWith(
      context,
      "rule-1",
      now,
      new Date("2026-09-04T00:00:00.000Z"),
      "MONITORING_EVALUATION_FAILED",
      "检查失败，请稍后重试",
    );
  });

  it("手动执行失败时记录安全错误且不泄露内部信息", async () => {
    repository.findRule.mockResolvedValue(ruleRecord());
    evaluator.evaluate.mockRejectedValue(new Error("database secret"));

    await expect(service.runRule(context, "rule-1")).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(repository.failRun).toHaveBeenCalledWith(
      context,
      "rule-1",
      now,
      new Date("2026-09-04T00:00:00.000Z"),
      "MONITORING_EVALUATION_FAILED",
      "检查失败，请稍后重试",
    );
  });

  it("其他用户规则表现为不存在", async () => {
    repository.findRule.mockResolvedValue(null);
    await expect(service.runRule(context, "other-rule")).rejects.toBeInstanceOf(NotFoundException);
  });
});

function ruleRecord() {
  return {
    id: "rule-1",
    name: "销售预警",
    definition,
    status: "ACTIVE" as const,
    lastRunAt: null,
    nextRunAt: now,
    lastErrorCode: null,
    lastErrorMessage: null,
    createdAt: now,
    updatedAt: now,
  };
}

function repositoryStub() {
  return {
    countActive: vi.fn(),
    createRule: vi.fn(),
    listRules: vi.fn(),
    findRule: vi.fn(),
    findDueRules: vi.fn(),
    updateStatus: vi.fn(),
    deleteRule: vi.fn(),
    completeRun: vi.fn(),
    failRun: vi.fn(),
    listNotifications: vi.fn(),
    unreadCount: vi.fn(),
    markRead: vi.fn(),
    markAllRead: vi.fn(),
  };
}
