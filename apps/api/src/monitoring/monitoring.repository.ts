import { getPrismaClient } from "@shopmate/database";
import {
  MonitoringRuleDefinitionSchema,
  type MonitoringRuleDefinition,
  type MonitoringRuleStatus,
  type MonitoringSeverity,
  type MonitoringResourceType,
} from "@shopmate/contracts";

import type { AuthContext } from "../auth/contracts/index.js";

export const MONITORING_REPOSITORY = Symbol("MONITORING_REPOSITORY");

export interface MonitoringRuleRecord {
  readonly id: string;
  readonly name: string;
  readonly definition: MonitoringRuleDefinition;
  readonly status: MonitoringRuleStatus;
  readonly lastRunAt: Date | null;
  readonly nextRunAt: Date;
  readonly lastErrorCode: string | null;
  readonly lastErrorMessage: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface PendingMonitoringNotification {
  readonly fingerprint: string;
  readonly title: string;
  readonly message: string;
  readonly severity: MonitoringSeverity;
  readonly resourceType: MonitoringResourceType;
  readonly resourceId: string;
  readonly periodStart: Date;
  readonly periodEnd: Date;
}

export interface MonitoringNotificationRecord extends PendingMonitoringNotification {
  readonly id: string;
  readonly ruleId: string;
  readonly ruleName: string;
  readonly readAt: Date | null;
  readonly createdAt: Date;
}

export interface MonitoringRepository {
  countActive(context: AuthContext): Promise<number>;
  createRule(
    context: AuthContext,
    name: string,
    definition: MonitoringRuleDefinition,
    nextRunAt: Date,
  ): Promise<MonitoringRuleRecord>;
  listRules(context: AuthContext): Promise<readonly MonitoringRuleRecord[]>;
  findRule(context: AuthContext, id: string): Promise<MonitoringRuleRecord | null>;
  findDueRules(
    context: AuthContext,
    dueAt: Date,
    limit: number,
  ): Promise<readonly MonitoringRuleRecord[]>;
  updateStatus(
    context: AuthContext,
    id: string,
    status: MonitoringRuleStatus,
    nextRunAt: Date,
  ): Promise<MonitoringRuleRecord | null>;
  deleteRule(context: AuthContext, id: string): Promise<boolean>;
  completeRun(
    context: AuthContext,
    id: string,
    completedAt: Date,
    nextRunAt: Date,
    notifications: readonly PendingMonitoringNotification[],
  ): Promise<number>;
  failRun(
    context: AuthContext,
    id: string,
    completedAt: Date,
    nextRunAt: Date,
    code: string,
    message: string,
  ): Promise<void>;
  listNotifications(
    context: AuthContext,
    limit: number,
  ): Promise<readonly MonitoringNotificationRecord[]>;
  unreadCount(context: AuthContext): Promise<number>;
  markRead(
    context: AuthContext,
    id: string,
    readAt: Date,
  ): Promise<MonitoringNotificationRecord | null>;
  markAllRead(context: AuthContext, readAt: Date): Promise<number>;
}

const ruleSelection = {
  id: true,
  name: true,
  definition: true,
  status: true,
  lastRunAt: true,
  nextRunAt: true,
  lastErrorCode: true,
  lastErrorMessage: true,
  createdAt: true,
  updatedAt: true,
} as const;

const notificationSelection = {
  id: true,
  ruleId: true,
  fingerprint: true,
  title: true,
  message: true,
  severity: true,
  resourceType: true,
  resourceId: true,
  periodStart: true,
  periodEnd: true,
  readAt: true,
  createdAt: true,
  rule: { select: { name: true } },
} as const;

export class PrismaMonitoringRepository implements MonitoringRepository {
  async countActive(context: AuthContext): Promise<number> {
    return getPrismaClient().userMonitoringRule.count({
      where: { ...identity(context), status: "ACTIVE" },
    });
  }

  async createRule(
    context: AuthContext,
    name: string,
    definition: MonitoringRuleDefinition,
    nextRunAt: Date,
  ): Promise<MonitoringRuleRecord> {
    const row = await getPrismaClient().userMonitoringRule.create({
      data: {
        ...identity(context),
        name,
        kind: definition.kind === "salesThreshold" ? "SALES_THRESHOLD" : "INVENTORY_THRESHOLD",
        definition,
        frequency: definition.frequency === "daily" ? "DAILY" : "WEEKLY",
        nextRunAt,
      },
      select: ruleSelection,
    });
    return mapRule(row);
  }

  async listRules(context: AuthContext): Promise<readonly MonitoringRuleRecord[]> {
    const rows = await getPrismaClient().userMonitoringRule.findMany({
      where: identity(context),
      orderBy: { createdAt: "desc" },
      select: ruleSelection,
    });
    return rows.map(mapRule);
  }

  async findRule(context: AuthContext, id: string): Promise<MonitoringRuleRecord | null> {
    const row = await getPrismaClient().userMonitoringRule.findFirst({
      where: { id, ...identity(context) },
      select: ruleSelection,
    });
    return row ? mapRule(row) : null;
  }

  async findDueRules(context: AuthContext, dueAt: Date, limit: number) {
    const rows = await getPrismaClient().userMonitoringRule.findMany({
      where: { ...identity(context), status: "ACTIVE", nextRunAt: { lte: dueAt } },
      orderBy: { nextRunAt: "asc" },
      take: limit,
      select: ruleSelection,
    });
    return rows.map(mapRule);
  }

  async updateStatus(
    context: AuthContext,
    id: string,
    status: MonitoringRuleStatus,
    nextRunAt: Date,
  ) {
    const changed = await getPrismaClient().userMonitoringRule.updateMany({
      where: { id, ...identity(context) },
      data: { status, nextRunAt, lastErrorCode: null, lastErrorMessage: null },
    });
    return changed.count === 0 ? null : this.findRule(context, id);
  }

  async deleteRule(context: AuthContext, id: string): Promise<boolean> {
    const deleted = await getPrismaClient().userMonitoringRule.deleteMany({
      where: { id, ...identity(context) },
    });
    return deleted.count > 0;
  }

  async completeRun(
    context: AuthContext,
    id: string,
    completedAt: Date,
    nextRunAt: Date,
    notifications: readonly PendingMonitoringNotification[],
  ): Promise<number> {
    return getPrismaClient().$transaction(async (transaction) => {
      const created = await transaction.monitoringNotification.createMany({
        data: notifications.map((notification) => ({
          ...notification,
          ruleId: id,
          ...identity(context),
        })),
        skipDuplicates: true,
      });
      await transaction.userMonitoringRule.updateMany({
        where: { id, ...identity(context) },
        data: { lastRunAt: completedAt, nextRunAt, lastErrorCode: null, lastErrorMessage: null },
      });
      return created.count;
    });
  }

  async failRun(
    context: AuthContext,
    id: string,
    completedAt: Date,
    nextRunAt: Date,
    code: string,
    message: string,
  ): Promise<void> {
    await getPrismaClient().userMonitoringRule.updateMany({
      where: { id, ...identity(context) },
      data: {
        lastRunAt: completedAt,
        nextRunAt,
        lastErrorCode: code,
        lastErrorMessage: message,
      },
    });
  }

  async listNotifications(context: AuthContext, limit: number) {
    const rows = await getPrismaClient().monitoringNotification.findMany({
      where: identity(context),
      orderBy: { createdAt: "desc" },
      take: limit,
      select: notificationSelection,
    });
    return rows.map(mapNotification);
  }

  async unreadCount(context: AuthContext): Promise<number> {
    return getPrismaClient().monitoringNotification.count({
      where: { ...identity(context), readAt: null },
    });
  }

  async markRead(context: AuthContext, id: string, readAt: Date) {
    const changed = await getPrismaClient().monitoringNotification.updateMany({
      where: { id, ...identity(context) },
      data: { readAt },
    });
    if (changed.count === 0) return null;
    const row = await getPrismaClient().monitoringNotification.findFirst({
      where: { id, ...identity(context) },
      select: notificationSelection,
    });
    return row ? mapNotification(row) : null;
  }

  async markAllRead(context: AuthContext, readAt: Date): Promise<number> {
    const changed = await getPrismaClient().monitoringNotification.updateMany({
      where: { ...identity(context), readAt: null },
      data: { readAt },
    });
    return changed.count;
  }
}

function identity(context: AuthContext) {
  return { userId: context.userId, merchantId: context.merchantId };
}

function mapRule(row: {
  id: string;
  name: string;
  definition: unknown;
  status: MonitoringRuleStatus;
  lastRunAt: Date | null;
  nextRunAt: Date;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  createdAt: Date;
  updatedAt: Date;
}): MonitoringRuleRecord {
  return { ...row, definition: MonitoringRuleDefinitionSchema.parse(row.definition) };
}

function mapNotification(row: {
  id: string;
  ruleId: string;
  fingerprint: string;
  title: string;
  message: string;
  severity: MonitoringSeverity;
  resourceType: MonitoringResourceType;
  resourceId: string;
  periodStart: Date;
  periodEnd: Date;
  readAt: Date | null;
  createdAt: Date;
  rule: { name: string };
}): MonitoringNotificationRecord {
  const { rule, ...notification } = row;
  return { ...notification, ruleName: rule.name };
}
