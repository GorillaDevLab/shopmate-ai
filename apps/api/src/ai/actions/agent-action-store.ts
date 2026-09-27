import { randomUUID } from "node:crypto";

import {
  AGENT_ACTION_TTL_MS,
  type AgentActionKind,
  type AgentActionProposal,
  type DashboardInsightQuery,
  type MonitoringRuleCreateRequest,
} from "@shopmate/contracts";

import type { ToolInvocationContext } from "../tools/tool-registry.js";

export type AgentActionPayload =
  | {
      readonly kind: "updateInventoryThreshold";
      readonly skuId: string;
      readonly expectedAlertThreshold: number;
      readonly expectedSkuUpdatedAt: string;
      readonly targetAlertThreshold: number;
    }
  | { readonly kind: "createMonitoringRule"; readonly rule: MonitoringRuleCreateRequest }
  | {
      readonly kind: "saveChartToAnalytics";
      readonly title: string;
      readonly query: DashboardInsightQuery;
    };

export interface StoredAgentAction {
  readonly proposal: AgentActionProposal;
  readonly payload: AgentActionPayload;
  readonly userId: string;
  readonly merchantId: string;
  readonly expiresAt: number;
}

export type TakeResult =
  | { readonly kind: "ok"; readonly action: StoredAgentAction }
  | { readonly kind: "expired" }
  | { readonly kind: "not_found" };

type Actor = Pick<ToolInvocationContext, "userId" | "merchantId">;
type ProposalContent = Pick<AgentActionProposal, "title" | "summary" | "details">;

const MAX_PENDING_PER_ACTOR = 30;
const MAX_PENDING_TOTAL = 5_000;

/**
 * 待确认操作只存在内存里：进程重启后未确认的卡片失效，需要让 AI 重新生成，
 * 不会有过时的操作在重启后被执行。令牌一次性使用并绑定提出时的用户与商家。
 */
export class AgentActionStore {
  private readonly actions = new Map<string, StoredAgentAction>();

  constructor(private readonly now: () => number = Date.now) {}

  propose(
    actor: Actor,
    content: ProposalContent,
    payload: AgentActionPayload,
  ): AgentActionProposal {
    this.prune();
    const pending = [...this.actions.values()].filter((action) => sameActor(action, actor));
    if (pending.length >= MAX_PENDING_PER_ACTOR || this.actions.size >= MAX_PENDING_TOTAL) {
      throw new Error("待确认的操作过多，请先处理已有的确认卡片。");
    }
    const expiresAt = this.now() + AGENT_ACTION_TTL_MS;
    const proposal: AgentActionProposal = {
      token: randomUUID(),
      kind: payload.kind satisfies AgentActionKind,
      ...content,
      expiresAt: new Date(expiresAt).toISOString(),
    };
    this.actions.set(proposal.token, { proposal, payload, ...actor, expiresAt });
    return proposal;
  }

  /** 取出即作废：同一张卡片不会被执行两次。别人的令牌与不存在的令牌表现一致。 */
  take(token: string, actor: Actor): TakeResult {
    const action = this.actions.get(token);
    if (!action || !sameActor(action, actor)) return { kind: "not_found" };
    this.actions.delete(token);
    if (action.expiresAt <= this.now()) return { kind: "expired" };
    return { kind: "ok", action };
  }

  private prune(): void {
    const now = this.now();
    for (const [token, action] of this.actions) {
      if (action.expiresAt <= now) this.actions.delete(token);
    }
  }
}

function sameActor(action: StoredAgentAction, actor: Actor): boolean {
  return action.userId === actor.userId && action.merchantId === actor.merchantId;
}
