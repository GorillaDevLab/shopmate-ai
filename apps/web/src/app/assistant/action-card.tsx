"use client";

import type { AgentActionOutcome, AgentActionProposal } from "@shopmate/contracts";
import Link from "next/link";
import { useState } from "react";

import { AssistantTransportError, cancelAgentAction, confirmAgentAction } from "./transport";

const STATUS_LABEL: Record<AgentActionOutcome["status"], string> = {
  done: "已执行",
  cancelled: "已取消",
  failed: "未执行",
  expired: "已过期",
};

/**
 * AI 提出的操作在这里由用户最终确认；卡片本身就是二次确认。
 * 结果写回本地对话，刷新后仍显示已执行 / 已取消。
 */
export function ActionProposalCard({
  proposal,
  outcome,
  onOutcome,
  now = Date.now,
}: {
  proposal: AgentActionProposal;
  outcome?: AgentActionOutcome;
  onOutcome: (outcome: AgentActionOutcome) => void;
  now?: () => number;
}) {
  const [busy, setBusy] = useState<"confirm" | "cancel" | null>(null);
  const expired = !outcome && Date.parse(proposal.expiresAt) <= now();
  const settled =
    outcome ??
    (expired
      ? { status: "expired" as const, message: "确认已过期，请让 AI 重新生成。" }
      : undefined);

  const run = async (action: "confirm" | "cancel") => {
    setBusy(action);
    try {
      if (action === "confirm") {
        const result = await confirmAgentAction(proposal.token);
        onOutcome({
          status: "done",
          message: result.message,
          ...(result.href ? { href: result.href } : {}),
        });
      } else {
        await cancelAgentAction(proposal.token);
        onOutcome({ status: "cancelled", message: "已取消，没有做任何修改。" });
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "操作未能执行，请稍后重试。";
      const status =
        error instanceof AssistantTransportError && error.status === 410 ? "expired" : "failed";
      onOutcome({ status, message });
    } finally {
      setBusy(null);
    }
  };

  return (
    <section
      className="assistant-action-card"
      aria-label={`待确认：${proposal.title}`}
      data-status={settled?.status ?? "pending"}
    >
      <header>
        <span className="assistant-action-badge">
          {settled ? STATUS_LABEL[settled.status] : "待你确认"}
        </span>
        <h3>{proposal.title}</h3>
      </header>
      <p>{proposal.summary}</p>
      {proposal.details.length > 0 && (
        <dl>
          {proposal.details.map((detail) => (
            <div key={detail.label}>
              <dt>{detail.label}</dt>
              <dd>{detail.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {settled ? (
        <p className="assistant-action-result" role="status">
          {settled.message}
          {settled.href && (
            <>
              {" "}
              <Link href={settled.href}>去查看</Link>
            </>
          )}
        </p>
      ) : (
        <div className="assistant-action-buttons">
          <button
            type="button"
            className="assistant-action-confirm"
            disabled={busy !== null}
            onClick={() => void run("confirm")}
          >
            {busy === "confirm" ? "正在执行…" : "确认执行"}
          </button>
          <button type="button" disabled={busy !== null} onClick={() => void run("cancel")}>
            取消
          </button>
        </div>
      )}
    </section>
  );
}
