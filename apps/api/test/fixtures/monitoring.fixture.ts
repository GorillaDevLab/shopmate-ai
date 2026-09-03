import type { MonitoringRuleDefinition, MonitoringRuleStatus } from "@shopmate/contracts";

import type { AuthContext } from "../../src/auth/contracts/index.js";
import type {
  MonitoringNotificationRecord,
  MonitoringRepository,
  MonitoringRuleRecord,
  PendingMonitoringNotification,
} from "../../src/monitoring/monitoring.repository.js";

export class FixtureMonitoringRepository implements MonitoringRepository {
  private readonly rules = new Map<string, MonitoringRuleRecord>();
  private readonly notifications = new Map<string, MonitoringNotificationRecord>();
  private sequence = 0;

  clear(): void {
    this.rules.clear();
    this.notifications.clear();
    this.sequence = 0;
  }

  async countActive(context: AuthContext): Promise<number> {
    return this.scopedRules(context).filter(({ status }) => status === "ACTIVE").length;
  }

  async createRule(
    context: AuthContext,
    name: string,
    definition: MonitoringRuleDefinition,
    nextRunAt: Date,
  ): Promise<MonitoringRuleRecord> {
    const now = new Date("2026-09-03T00:00:00.000Z");
    const rule = {
      id: `rule-${++this.sequence}`,
      name,
      definition,
      status: "ACTIVE" as const,
      lastRunAt: null,
      nextRunAt,
      lastErrorCode: null,
      lastErrorMessage: null,
      createdAt: now,
      updatedAt: now,
    };
    this.rules.set(resourceKey(context, rule.id), rule);
    return rule;
  }

  async listRules(context: AuthContext): Promise<readonly MonitoringRuleRecord[]> {
    return this.scopedRules(context);
  }

  async findRule(context: AuthContext, id: string): Promise<MonitoringRuleRecord | null> {
    return this.rules.get(resourceKey(context, id)) ?? null;
  }

  async findDueRules(context: AuthContext, dueAt: Date, limit: number) {
    return this.scopedRules(context)
      .filter((rule) => rule.status === "ACTIVE" && rule.nextRunAt <= dueAt)
      .slice(0, limit);
  }

  async updateStatus(
    context: AuthContext,
    id: string,
    status: MonitoringRuleStatus,
    nextRunAt: Date,
  ): Promise<MonitoringRuleRecord | null> {
    const rule = await this.findRule(context, id);
    if (!rule) return null;
    const updated = { ...rule, status, nextRunAt, updatedAt: nextRunAt };
    this.rules.set(resourceKey(context, id), updated);
    return updated;
  }

  async deleteRule(context: AuthContext, id: string): Promise<boolean> {
    return this.rules.delete(resourceKey(context, id));
  }

  async completeRun(
    context: AuthContext,
    id: string,
    completedAt: Date,
    nextRunAt: Date,
    pending: readonly PendingMonitoringNotification[],
  ): Promise<number> {
    const rule = await this.findRule(context, id);
    if (!rule) return 0;
    this.rules.set(resourceKey(context, id), {
      ...rule,
      lastRunAt: completedAt,
      nextRunAt,
      lastErrorCode: null,
      lastErrorMessage: null,
    });
    return this.addNotifications(context, rule, pending, completedAt);
  }

  async failRun(
    context: AuthContext,
    id: string,
    completedAt: Date,
    nextRunAt: Date,
    code: string,
    message: string,
  ): Promise<void> {
    const rule = await this.findRule(context, id);
    if (!rule) return;
    this.rules.set(resourceKey(context, id), {
      ...rule,
      lastRunAt: completedAt,
      nextRunAt,
      lastErrorCode: code,
      lastErrorMessage: message,
    });
  }

  async listNotifications(context: AuthContext, limit: number) {
    return this.scopedNotifications(context).slice(0, limit);
  }

  async unreadCount(context: AuthContext): Promise<number> {
    return this.scopedNotifications(context).filter(({ readAt }) => readAt === null).length;
  }

  async markRead(context: AuthContext, id: string, readAt: Date) {
    const key = resourceKey(context, id);
    const notification = this.notifications.get(key);
    if (!notification) return null;
    const updated = { ...notification, readAt };
    this.notifications.set(key, updated);
    return updated;
  }

  async markAllRead(context: AuthContext, readAt: Date): Promise<number> {
    const unread = this.scopedNotifications(context).filter(({ readAt: value }) => value === null);
    for (const notification of unread) {
      this.notifications.set(resourceKey(context, notification.id), { ...notification, readAt });
    }
    return unread.length;
  }

  private scopedRules(context: AuthContext): MonitoringRuleRecord[] {
    const prefix = `${scopeKey(context)}/`;
    return [...this.rules.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([, rule]) => rule);
  }

  private scopedNotifications(context: AuthContext): MonitoringNotificationRecord[] {
    const prefix = `${scopeKey(context)}/`;
    return [...this.notifications.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([, notification]) => notification)
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime());
  }

  private addNotifications(
    context: AuthContext,
    rule: MonitoringRuleRecord,
    pending: readonly PendingMonitoringNotification[],
    createdAt: Date,
  ): number {
    let created = 0;
    for (const item of pending) {
      if (this.hasFingerprint(context, item.fingerprint)) continue;
      const id = `notification-${++this.sequence}`;
      this.notifications.set(resourceKey(context, id), {
        ...item,
        id,
        ruleId: rule.id,
        ruleName: rule.name,
        readAt: null,
        createdAt,
      });
      created += 1;
    }
    return created;
  }

  private hasFingerprint(context: AuthContext, fingerprint: string): boolean {
    return this.scopedNotifications(context).some((item) => item.fingerprint === fingerprint);
  }
}

function scopeKey(context: AuthContext): string {
  return `${encodeURIComponent(context.userId)}/${encodeURIComponent(context.merchantId)}`;
}

function resourceKey(context: AuthContext, id: string): string {
  return `${scopeKey(context)}/${encodeURIComponent(id)}`;
}
