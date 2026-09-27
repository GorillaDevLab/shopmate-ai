import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { AssistantStoreProvider } from "../assistant/provider";
import { AssistantStore } from "../assistant/store";
import { DashboardApiError } from "../dashboard-api";
import { overviewFixture } from "./analytics-fixture";

const router = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router, usePathname: () => "/analytics" }));

const api = vi.hoisted(() => ({ fetchAnalyticsOverview: vi.fn() }));
vi.mock("./analytics-api", () => api);

const insightApi = vi.hoisted(() => ({ executeDashboardInsight: vi.fn() }));
vi.mock("../dashboard-insight-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../dashboard-insight-api")>()),
  ...insightApi,
}));

const layoutApi = vi.hoisted(() => ({
  fetchAnalyticsLayout: vi.fn(),
  saveAnalyticsLayout: vi.fn(),
}));
vi.mock("./analytics-layout-api", () => layoutApi);

import { DEFAULT_ANALYTICS_LAYOUT } from "@shopmate/contracts";
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

beforeAll(() => {
  // jsdom 没有原生 dialog；焦点与 Esc 行为由浏览器验证。
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
    this.dispatchEvent(new Event("close"));
  };
});

describe("AnalyticsClient", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    layoutApi.fetchAnalyticsLayout.mockResolvedValue({
      layout: DEFAULT_ANALYTICS_LAYOUT,
      revision: 2,
      updatedAt: "2026-09-01T00:00:00.000Z",
    });
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

  it("edits the layout: hide a card, reset needs confirmation, save sends the read revision", async () => {
    api.fetchAnalyticsOverview.mockResolvedValue(overviewFixture());
    layoutApi.saveAnalyticsLayout.mockImplementation(async (layout) => ({
      layout,
      revision: 3,
      updatedAt: "2026-09-28T00:00:00.000Z",
    }));
    renderClient();
    fireEvent.click(await screen.findByRole("button", { name: "编辑看板" }));
    fireEvent.click(screen.getByRole("button", { name: "隐藏各渠道每日销售额" }));
    const hiddenTray = screen.getByRole("group", { name: "已隐藏的卡片" });
    expect(
      within(hiddenTray).getByRole("button", { name: "+ 各渠道每日销售额" }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "恢复默认" }));
    // 只打开确认框，布局尚未改变。
    const confirm = screen.getByRole("dialog", { name: "恢复默认布局？" });
    expect(screen.getByRole("group", { name: "已隐藏的卡片" })).toBeInTheDocument();
    fireEvent.click(within(confirm).getByRole("button", { name: "取消" }));
    expect(screen.getByRole("group", { name: "已隐藏的卡片" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "保存布局" }));
    await waitFor(() => expect(layoutApi.saveAnalyticsLayout).toHaveBeenCalledTimes(1));
    const [saved, revision] = layoutApi.saveAnalyticsLayout.mock.calls[0];
    expect(revision).toBe(2);
    expect(saved.cards.map((card: { id: string }) => card.id)).not.toContain("channelDaily");
    expect(await screen.findByRole("button", { name: "编辑看板" })).toBeInTheDocument();
    expect(screen.queryByRole("article", { name: "各渠道每日销售额" })).not.toBeInTheDocument();
  });

  it("restores the default layout after confirmation", async () => {
    api.fetchAnalyticsOverview.mockResolvedValue(overviewFixture());
    renderClient();
    fireEvent.click(await screen.findByRole("button", { name: "编辑看板" }));
    fireEvent.click(screen.getByRole("button", { name: "隐藏销售额" }));
    fireEvent.click(screen.getByRole("button", { name: "恢复默认" }));
    const confirm = screen.getByRole("dialog", { name: "恢复默认布局？" });
    fireEvent.click(within(confirm).getByRole("button", { name: "恢复默认" }));
    expect(screen.queryByRole("group", { name: "已隐藏的卡片" })).not.toBeInTheDocument();
  });

  it("cancelling an edit keeps the saved layout", async () => {
    api.fetchAnalyticsOverview.mockResolvedValue(overviewFixture());
    renderClient();
    fireEvent.click(await screen.findByRole("button", { name: "编辑看板" }));
    fireEvent.click(screen.getByRole("button", { name: "隐藏销售额" }));
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(screen.getAllByRole("article", { name: "销售额" })).toHaveLength(2);
    expect(layoutApi.saveAnalyticsLayout).not.toHaveBeenCalled();
  });

  it("keeps showing data when the layout fails to load and retries it on edit", async () => {
    api.fetchAnalyticsOverview.mockResolvedValue(overviewFixture());
    layoutApi.fetchAnalyticsLayout.mockRejectedValueOnce(
      new DashboardApiError("布局服务暂时不可用", 503),
    );
    renderClient();
    expect(await screen.findByRole("region", { name: "经营图表" })).toBeInTheDocument();
    expect(screen.getByText("布局读取失败，点击“编辑看板”重试")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "编辑看板" }));
    expect(await screen.findByRole("region", { name: "编辑看板" })).toBeInTheDocument();
    expect(layoutApi.fetchAnalyticsLayout).toHaveBeenCalledTimes(2);
  });

  it("renders saved AI charts for the page period and deletes them only after confirmation", async () => {
    const overview = overviewFixture();
    api.fetchAnalyticsOverview.mockResolvedValue(overview);
    const aiCard = {
      id: "ai-0123456789abcdef01234567",
      kind: "aiChart" as const,
      span: 1 as const,
      title: "各门店客单价",
      query: {
        dataset: "sales" as const,
        metric: "averageOrderValue" as const,
        aggregation: "average" as const,
        groupBy: "store" as const,
        dateRange: { start: "2026-01-01", end: "2026-01-31" },
        filters: [],
        order: "desc" as const,
        limit: 8,
        visualization: "bar" as const,
      },
    };
    layoutApi.fetchAnalyticsLayout.mockResolvedValue({
      layout: { version: 1, cards: [...DEFAULT_ANALYTICS_LAYOUT.cards, aiCard] },
      revision: 4,
      updatedAt: "2026-09-01T00:00:00.000Z",
    });
    insightApi.executeDashboardInsight.mockResolvedValue({
      kind: "pie",
      title: "各门店客单价",
      summary: "s",
      unit: "currencyMinor",
      slices: [{ key: "s1", label: "北京朝阳店", value: 98000 }],
    });
    renderClient();
    const card = await screen.findByRole("article", { name: "各门店客单价" });
    expect(await within(card).findByText("北京朝阳店")).toBeInTheDocument();
    expect(insightApi.executeDashboardInsight).toHaveBeenCalledWith(
      expect.objectContaining({
        dateRange: { start: overview.period.startDate, end: overview.period.endDate },
      }),
      expect.any(AbortSignal),
    );

    fireEvent.click(screen.getByRole("button", { name: "编辑看板" }));
    fireEvent.click(screen.getByRole("button", { name: "删除各门店客单价" }));
    const confirm = screen.getByRole("dialog", { name: "删除「各门店客单价」？" });
    fireEvent.click(within(confirm).getByRole("button", { name: "取消" }));
    expect(screen.getByRole("article", { name: "各门店客单价" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "删除各门店客单价" }));
    fireEvent.click(
      within(screen.getByRole("dialog", { name: "删除「各门店客单价」？" })).getByRole("button", {
        name: "删除",
      }),
    );
    expect(screen.queryByRole("article", { name: "各门店客单价" })).not.toBeInTheDocument();
  });
});
