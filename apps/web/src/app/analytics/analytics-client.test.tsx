import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AssistantStoreProvider } from "../assistant/provider";
import { AssistantStore } from "../assistant/store";
import { DashboardApiError } from "../dashboard-api";
import { overviewFixture } from "./analytics-fixture";

const router = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router, usePathname: () => "/analytics" }));

const api = vi.hoisted(() => ({ fetchAnalyticsOverview: vi.fn() }));
vi.mock("./analytics-api", () => api);

import { AnalyticsClient } from "./analytics-client";

function renderClient() {
  const store = new AssistantStore(undefined);
  store.activate({ userId: "test-user", merchantId: "test-merchant" });
  const setDraft = vi.spyOn(store, "setDraft");
  const wrapper = ({ children }: { children: ReactNode }) => (
    <AssistantStoreProvider store={store}>{children}</AssistantStoreProvider>
  );
  render(<AnalyticsClient asOfDate="2026-08-31" />, { wrapper });
  return { setDraft };
}

describe("AnalyticsClient", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("[]", { status: 200 })),
    );
  });

  it("requests the last 30 days by default and shows a loading state", () => {
    api.fetchAnalyticsOverview.mockReturnValue(new Promise(() => {}));
    renderClient();
    expect(screen.getByText("正在整理你的经营数据…")).toBeInTheDocument();
    expect(api.fetchAnalyticsOverview).toHaveBeenCalledWith(
      "2026-08-31",
      "2026-08-02",
      expect.any(AbortSignal),
    );
  });

  it("renders insights, KPI tiles and channel charts when data is ready", async () => {
    api.fetchAnalyticsOverview.mockResolvedValue(overviewFixture());
    renderClient();
    const kpis = await screen.findByRole("region", { name: "经营指标" });
    expect(within(kpis).getByRole("article", { name: "销售额" })).toBeInTheDocument();
    expect(screen.getByRole("tablist", { name: "洞察列表" })).toBeInTheDocument();
    expect(screen.getByRole("article", { name: "各渠道销售额占比" })).toBeInTheDocument();
    expect(screen.getByRole("article", { name: "各渠道每日销售额" })).toBeInTheDocument();
    expect(screen.getByRole("table", { name: "每日销售额" })).toBeInTheDocument();
  });

  it("switches insight topics and drafts the question for the assistant without sending", async () => {
    api.fetchAnalyticsOverview.mockResolvedValue(overviewFixture());
    const { setDraft } = renderClient();
    const tabs = await screen.findAllByRole("tab");
    fireEvent.click(tabs[1]);
    expect(tabs[1]).toHaveAttribute("aria-selected", "true");
    fireEvent.click(screen.getByRole("button", { name: "问 AI 为什么" }));
    expect(setDraft).toHaveBeenCalledWith(expect.stringContaining("小红书店"));
    expect(router.push).toHaveBeenCalledWith("/chat");
  });

  it("explains missing channel data instead of drawing empty channel charts", async () => {
    api.fetchAnalyticsOverview.mockResolvedValue(overviewFixture({ channels: [] }));
    renderClient();
    expect(await screen.findByText(/还没有门店或店铺数据/)).toBeInTheDocument();
    expect(screen.queryByRole("article", { name: "各渠道销售额占比" })).not.toBeInTheDocument();
    expect(screen.getByRole("table", { name: "每日销售额" })).toBeInTheDocument();
  });

  it("shows the empty state when neither period has orders", async () => {
    const empty = overviewFixture();
    api.fetchAnalyticsOverview.mockResolvedValue({
      ...empty,
      totals: {
        current: { revenueMinor: 0, orders: 0, units: 0 },
        previous: { revenueMinor: 0, orders: 0, units: 0 },
      },
    });
    renderClient();
    expect(await screen.findByText("还没有经营数据")).toBeInTheDocument();
  });

  it("offers re-login on 401 and retries on demand", async () => {
    api.fetchAnalyticsOverview.mockRejectedValueOnce(
      new DashboardApiError("登录已失效，请重新登录", 401),
    );
    renderClient();
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByRole("link", { name: "重新登录" })).toHaveAttribute("href", "/login");
    api.fetchAnalyticsOverview.mockResolvedValue(overviewFixture());
    fireEvent.click(within(alert).getByRole("button", { name: "重新加载" }));
    await waitFor(() => expect(api.fetchAnalyticsOverview).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole("region", { name: "经营指标" })).toBeInTheDocument();
  });

  it("shows the service message for non-auth failures", async () => {
    api.fetchAnalyticsOverview.mockRejectedValue(
      new DashboardApiError("经营数据暂时不可用，请稍后重试", 503),
    );
    renderClient();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("经营数据暂时不可用，请稍后重试");
    expect(within(alert).queryByRole("link", { name: "重新登录" })).not.toBeInTheDocument();
  });
});
