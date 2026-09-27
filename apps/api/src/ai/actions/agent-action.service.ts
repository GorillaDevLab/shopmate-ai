import { randomBytes } from "node:crypto";

import {
  ConflictException,
  ForbiddenException,
  GoneException,
  HttpException,
  NotFoundException,
} from "@nestjs/common";
import {
  ANALYTICS_MAX_AI_CARDS,
  AgentActionConfirmResponseSchema,
  AgentActionIdSchema,
  isAnalyticsAiCard,
  type AgentActionConfirmResponse,
} from "@shopmate/contracts";

import type { AnalyticsLayoutService } from "../../analytics/analytics-layout.service.js";
import { AuthPermission, type AuthContext } from "../../auth/contracts/auth-context.js";
import type { MonitoringService } from "../../monitoring/monitoring.service.js";
import type { InventoryAlertUpdateRepository } from "../tools/inventory-alert-update.repository.js";
import type { AgentActionPayload, AgentActionStore } from "./agent-action-store.js";

type Monitoring = Pick<MonitoringService, "create">;
type Layouts = Pick<AnalyticsLayoutService, "get" | "save">;
type Inventory = Pick<InventoryAlertUpdateRepository, "confirmAlertThreshold">;

const REQUIRED_PERMISSIONS: Record<AgentActionPayload["kind"], readonly AuthPermission[]> = {
  updateInventoryThreshold: [AuthPermission.InventoryWrite],
  createMonitoringRule: [AuthPermission.OrdersRead],
  saveChartToAnalytics: [AuthPermission.OrdersRead, AuthPermission.ProductsRead],
};

/** 只有用户在卡片上点确认才会走到这里；模型没有调用它的途径。 */
export class AgentActionService {
  constructor(
    private readonly store: AgentActionStore,
    private readonly inventory: Inventory,
    private readonly monitoring: Monitoring,
    private readonly layouts: Layouts,
  ) {}

  async confirm(context: AuthContext, rawActionId: string): Promise<AgentActionConfirmResponse> {
    const taken = this.store.take(parseActionId(rawActionId), context);
    if (taken.kind === "not_found") throw new NotFoundException({ code: "ACTION_NOT_FOUND" });
    if (taken.kind === "expired") {
      throw new GoneException({
        code: "ACTION_EXPIRED",
        message: "确认已过期，请让 AI 重新生成。",
      });
    }
    const { payload } = taken.action;
    // 提出与确认之间权限可能已被收回，执行前再检查一次。
    if (!REQUIRED_PERMISSIONS[payload.kind].every((p) => context.permissions.includes(p))) {
      throw new ForbiddenException({
        code: "ACTION_FORBIDDEN",
        message: "当前账号没有执行此操作的权限。",
      });
    }
    return AgentActionConfirmResponseSchema.parse(await this.execute(context, payload));
  }

  cancel(context: AuthContext, rawActionId: string): { status: "cancelled" } {
    this.store.take(parseActionId(rawActionId), context);
    return { status: "cancelled" };
  }

  private execute(context: AuthContext, payload: AgentActionPayload) {
    switch (payload.kind) {
      case "updateInventoryThreshold":
        return this.updateInventory(context, payload);
      case "createMonitoringRule":
        return this.createRule(context, payload);
      case "saveChartToAnalytics":
        return this.saveChart(context, payload);
    }
  }

  private async updateInventory(
    context: AuthContext,
    payload: Extract<AgentActionPayload, { kind: "updateInventoryThreshold" }>,
  ): Promise<AgentActionConfirmResponse> {
    const result = await this.inventory.confirmAlertThreshold({
      merchantId: context.merchantId,
      skuId: payload.skuId,
      expectedAlertThreshold: payload.expectedAlertThreshold,
      expectedSkuUpdatedAt: payload.expectedSkuUpdatedAt,
      targetAlertThreshold: payload.targetAlertThreshold,
    });
    if (result.kind === "NOT_FOUND")
      throw new NotFoundException({ code: "ACTION_TARGET_NOT_FOUND" });
    if (result.kind === "CONFLICT") {
      throw new ConflictException({
        code: "ACTION_CONFLICT",
        message: `该商品的库存设置已被修改（当前阈值 ${result.actualAlertThreshold}），未执行。请让 AI 按最新数据重新生成。`,
      });
    }
    return {
      status: "done",
      message: `已将 ${result.skuId} 的库存预警阈值从 ${result.previousAlertThreshold} 调整为 ${result.newAlertThreshold}。`,
    };
  }

  private async createRule(
    context: AuthContext,
    payload: Extract<AgentActionPayload, { kind: "createMonitoringRule" }>,
  ): Promise<AgentActionConfirmResponse> {
    await this.monitoring.create(context, payload.rule);
    return {
      status: "done",
      message: `已创建经营监听「${payload.rule.name}」，可在侧栏“经营监听”查看。`,
    };
  }

  private async saveChart(
    context: AuthContext,
    payload: Extract<AgentActionPayload, { kind: "saveChartToAnalytics" }>,
  ): Promise<AgentActionConfirmResponse> {
    const { layout, revision } = await this.layouts.get(context);
    if (layout.cards.filter(isAnalyticsAiCard).length >= ANALYTICS_MAX_AI_CARDS) {
      throw new HttpException(
        {
          code: "ACTION_LIMIT",
          message: `经营分析最多保存 ${ANALYTICS_MAX_AI_CARDS} 张 AI 图表，请先删除一些。`,
        },
        409,
      );
    }
    const card = {
      id: `ai-${randomBytes(12).toString("hex")}`,
      kind: "aiChart" as const,
      span: payload.query.groupBy === "date" ? (2 as const) : (1 as const),
      title: payload.title,
      query: payload.query,
    };
    await this.layouts.save(context, {
      layout: { ...layout, cards: [...layout.cards, card] },
      expectedRevision: revision,
    });
    return { status: "done", message: `已把「${payload.title}」保存到经营分析。`, href: "/" };
  }
}

function parseActionId(raw: string): string {
  const actionId = AgentActionIdSchema.safeParse(raw);
  if (!actionId.success) throw new NotFoundException({ code: "ACTION_NOT_FOUND" });
  return actionId.data;
}
