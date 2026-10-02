import type { AgentActionProposal } from "@shopmate/contracts";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ActionProposalCard } from "./action-card";

const proposal: AgentActionProposal = {
  actionId: "0b5f0a3e-4f6a-4b8b-9a55-1c2d3e4f5a6b",
  kind: "saveChartToAnalytics",
  title: "保存图表到经营分析",
  summary: "各门店销售额",
  details: [{ label: "指标", value: "销售额" }],
  expiresAt: "2026-09-28T01:15:00.000Z",
};
const beforeExpiry = () => Date.parse("2026-09-28T01:00:00.000Z");

function stubFetch(status: number, body: unknown) {
  const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("ActionProposalCard", () => {
  beforeEach(() => vi.unstubAllGlobals());

  it("shows what will change and only acts when the user confirms", async () => {
    const fetchMock = stubFetch(200, {
      status: "done",
      message: "已把「各门店销售额」保存到经营分析。",
      href: "/",
    });
    const onOutcome = vi.fn();
    render(<ActionProposalCard proposal={proposal} onOutcome={onOutcome} now={beforeExpiry} />);
    expect(screen.getByText("待你确认")).toBeInTheDocument();
    expect(screen.getByText("销售额")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "确认执行" }));
    await waitFor(() =>
      expect(onOutcome).toHaveBeenCalledWith({
        status: "done",
        message: "已把「各门店销售额」保存到经营分析。",
        href: "/",
      }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/v1/ai/actions/${proposal.actionId}/confirm`,
      expect.objectContaining({ method: "POST", credentials: "include" }),
    );
  });

  it("cancels without changing anything", async () => {
    const fetchMock = stubFetch(200, { status: "cancelled" });
    const onOutcome = vi.fn();
    render(<ActionProposalCard proposal={proposal} onOutcome={onOutcome} now={beforeExpiry} />);
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    await waitFor(() =>
      expect(onOutcome).toHaveBeenCalledWith(expect.objectContaining({ status: "cancelled" })),
    );
    expect(fetchMock.mock.calls[0]?.[0]).toContain("/cancel");
  });

  it("reports server-side refusals such as conflicts", async () => {
    stubFetch(409, {
      code: "ACTION_CONFLICT",
      message: "该商品的库存设置已被修改（当前阈值 12），未执行。",
    });
    const onOutcome = vi.fn();
    render(<ActionProposalCard proposal={proposal} onOutcome={onOutcome} now={beforeExpiry} />);
    fireEvent.click(screen.getByRole("button", { name: "确认执行" }));
    await waitFor(() =>
      expect(onOutcome).toHaveBeenCalledWith({
        status: "failed",
        message: "该商品的库存设置已被修改（当前阈值 12），未执行。",
      }),
    );
  });

  it("disables expired proposals and shows a stored outcome after reload", () => {
    const { rerender } = render(
      <ActionProposalCard
        proposal={proposal}
        onOutcome={vi.fn()}
        now={() => Date.parse("2026-09-28T02:00:00.000Z")}
      />,
    );
    expect(screen.getByText("已过期")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "确认执行" })).not.toBeInTheDocument();

    rerender(
      <ActionProposalCard
        proposal={proposal}
        outcome={{ status: "done", message: "已保存。", href: "/" }}
        onOutcome={vi.fn()}
        now={beforeExpiry}
      />,
    );
    expect(screen.getByText("已执行")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "去查看" })).toHaveAttribute("href", "/");
  });
});
