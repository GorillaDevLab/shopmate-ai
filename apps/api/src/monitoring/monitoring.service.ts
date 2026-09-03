import { createHash } from "node:crypto";

import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import {
  MonitoringNotificationListResponseSchema,
  MonitoringReadAllResponseSchema,
  MonitoringReadResponseSchema,
  MonitoringRuleCreateRequestSchema,
  MonitoringRuleListResponseSchema,
  MonitoringRuleResponseSchema,
  MonitoringRuleRunResponseSchema,
  MonitoringRuleStatusRequestSchema,
  MonitoringSyncResponseSchema,
  MonitoringUnreadCountResponseSchema,
  type MonitoringEvaluation,
  type MonitoringRuleDefinition,
} from "@shopmate/contracts";

import type { AuthContext } from "../auth/contracts/index.js";
import { nextRunAt } from "./monitoring-schedule.js";
import type {
  MonitoringNotificationRecord,
  MonitoringRepository,
  MonitoringRuleRecord,
  PendingMonitoringNotification,
} from "./monitoring.repository.js";

const ACTIVE_RULE_LIMIT = 10;
const DUE_RULE_LIMIT = 10;

interface RuleEvaluator {
  evaluate(
    context: AuthContext,
    definition: MonitoringRuleDefinition,
    now: Date,
  ): Promise<MonitoringEvaluation>;
}

export class MonitoringService {
  constructor(
    private readonly repository: MonitoringRepository,
    private readonly evaluator: RuleEvaluator,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async create(context: AuthContext, rawRequest: unknown) {
    const request = MonitoringRuleCreateRequestSchema.safeParse(rawRequest);
    if (!request.success) throwInvalidRequest();
    await this.assertActiveCapacity(context);
    const createdAt = this.now();
    const rule = await this.repository.createRule(
      context,
      request.data.name,
      request.data.definition,
      nextRunAt(request.data.definition.frequency, createdAt),
    );
    return MonitoringRuleResponseSchema.parse({ rule: ruleView(rule) });
  }

  async listRules(context: AuthContext) {
    const rules = await this.repository.listRules(context);
    return MonitoringRuleListResponseSchema.parse({ items: rules.map(ruleView) });
  }

  async updateStatus(context: AuthContext, id: string, rawRequest: unknown) {
    const request = MonitoringRuleStatusRequestSchema.safeParse(rawRequest);
    if (!request.success) throwInvalidRequest();
    const existing = await this.requireRule(context, id);
    if (existing.status === "INACTIVE" && request.data.status === "ACTIVE") {
      await this.assertActiveCapacity(context);
    }
    const rule = await this.repository.updateStatus(context, id, request.data.status, this.now());
    if (!rule) throwMissing();
    return MonitoringRuleResponseSchema.parse({ rule: ruleView(rule) });
  }

  async deleteRule(context: AuthContext, id: string): Promise<void> {
    if (!(await this.repository.deleteRule(context, id))) throwMissing();
  }

  async runRule(context: AuthContext, id: string) {
    const rule = await this.requireRule(context, id);
    if (rule.status !== "ACTIVE") throwInactive();
    const completedAt = this.now();
    let result: { evaluation: MonitoringEvaluation; createdNotifications: number };
    try {
      result = await this.executeRule(context, rule, completedAt);
    } catch {
      await this.recordFailure(context, rule, completedAt);
      throwEvaluationFailed();
    }
    const updated = await this.requireRule(context, id);
    return MonitoringRuleRunResponseSchema.parse({
      rule: ruleView(updated),
      evaluation: result.evaluation,
      createdNotifications: result.createdNotifications,
    });
  }

  async sync(context: AuthContext) {
    const completedAt = this.now();
    const rules = await this.repository.findDueRules(context, completedAt, DUE_RULE_LIMIT);
    let createdNotifications = 0;
    let failedRules = 0;
    for (const rule of rules) {
      try {
        createdNotifications += (await this.executeRule(context, rule, completedAt))
          .createdNotifications;
      } catch {
        failedRules += 1;
        await this.recordFailure(context, rule, completedAt);
      }
    }
    return MonitoringSyncResponseSchema.parse({
      evaluatedRules: rules.length,
      createdNotifications,
      failedRules,
    });
  }

  async listNotifications(context: AuthContext, limit = 30) {
    const items = await this.repository.listNotifications(
      context,
      Math.min(Math.max(limit, 1), 50),
    );
    return MonitoringNotificationListResponseSchema.parse({ items: items.map(notificationView) });
  }

  async unreadCount(context: AuthContext) {
    return MonitoringUnreadCountResponseSchema.parse({
      count: await this.repository.unreadCount(context),
    });
  }

  async markRead(context: AuthContext, id: string) {
    const notification = await this.repository.markRead(context, id, this.now());
    if (!notification) throwMissing();
    return MonitoringReadResponseSchema.parse({ notification: notificationView(notification) });
  }

  async markAllRead(context: AuthContext) {
    return MonitoringReadAllResponseSchema.parse({
      updated: await this.repository.markAllRead(context, this.now()),
    });
  }

  private async executeRule(context: AuthContext, rule: MonitoringRuleRecord, completedAt: Date) {
    const evaluation = await this.evaluator.evaluate(context, rule.definition, completedAt);
    const next = nextRunAt(rule.definition.frequency, completedAt);
    const notifications = evaluation.matches.map((match) =>
      pendingNotification(rule.id, evaluation, match),
    );
    const createdNotifications = await this.repository.completeRun(
      context,
      rule.id,
      completedAt,
      next,
      notifications,
    );
    return { evaluation, createdNotifications };
  }

  private async recordFailure(context: AuthContext, rule: MonitoringRuleRecord, completedAt: Date) {
    await this.repository.failRun(
      context,
      rule.id,
      completedAt,
      nextRunAt(rule.definition.frequency, completedAt),
      "MONITORING_EVALUATION_FAILED",
      "检查失败，请稍后重试",
    );
  }

  private async requireRule(context: AuthContext, id: string): Promise<MonitoringRuleRecord> {
    const rule = await this.repository.findRule(context, id);
    if (!rule) throwMissing();
    return rule;
  }

  private async assertActiveCapacity(context: AuthContext): Promise<void> {
    if ((await this.repository.countActive(context)) >= ACTIVE_RULE_LIMIT) throwLimitReached();
  }
}

function pendingNotification(
  ruleId: string,
  evaluation: MonitoringEvaluation,
  match: MonitoringEvaluation["matches"][number],
): PendingMonitoringNotification {
  return {
    ...match,
    fingerprint: createHash("sha256")
      .update(
        [
          ruleId,
          match.resourceType,
          match.resourceId,
          evaluation.periodStart,
          evaluation.periodEnd,
        ].join(":"),
      )
      .digest("hex"),
    periodStart: new Date(evaluation.periodStart),
    periodEnd: new Date(evaluation.periodEnd),
  };
}

function ruleView(rule: MonitoringRuleRecord) {
  return {
    ...rule,
    lastRunAt: rule.lastRunAt?.toISOString() ?? null,
    nextRunAt: rule.nextRunAt.toISOString(),
    createdAt: rule.createdAt.toISOString(),
    updatedAt: rule.updatedAt.toISOString(),
  };
}

function notificationView(notification: MonitoringNotificationRecord) {
  return {
    id: notification.id,
    ruleId: notification.ruleId,
    ruleName: notification.ruleName,
    title: notification.title,
    message: notification.message,
    severity: notification.severity,
    resourceType: notification.resourceType,
    resourceId: notification.resourceId,
    periodStart: notification.periodStart.toISOString(),
    periodEnd: notification.periodEnd.toISOString(),
    readAt: notification.readAt?.toISOString() ?? null,
    createdAt: notification.createdAt.toISOString(),
  };
}

function throwInvalidRequest(): never {
  throw new BadRequestException({
    statusCode: 400,
    code: "INVALID_MONITORING_REQUEST",
    message: "监听请求格式无效",
    retryable: false,
  });
}

function throwMissing(): never {
  throw new NotFoundException({
    statusCode: 404,
    code: "RESOURCE_NOT_FOUND",
    message: "资源不存在",
  });
}

function throwLimitReached(): never {
  throw new ConflictException({
    statusCode: 409,
    code: "MONITORING_RULE_LIMIT_REACHED",
    message: "最多启用 10 条监听规则",
    retryable: false,
  });
}

function throwInactive(): never {
  throw new ConflictException({
    statusCode: 409,
    code: "MONITORING_RULE_INACTIVE",
    message: "请先启用该监听规则",
    retryable: false,
  });
}

function throwEvaluationFailed(): never {
  throw new ServiceUnavailableException({
    statusCode: 503,
    code: "MONITORING_EVALUATION_FAILED",
    message: "检查失败，请稍后重试",
    retryable: true,
  });
}
