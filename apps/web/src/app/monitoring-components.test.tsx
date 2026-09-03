import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./monitoring-api", () => ({
  createMonitoringRule: vi.fn(),
  deleteMonitoringRule: vi.fn(),
  getMonitoringUnreadCount: vi.fn(),
  listMonitoringNotifications: vi.fn(),
  listMonitoringRules: vi.fn(),
  markAllMonitoringNotificationsRead: vi.fn(),
  markMonitoringNotificationRead: vi.fn(),
  previewMonitoringRule: vi.fn(),
  runMonitoringRule: vi.fn(),
  syncMonitoring: vi.fn(),
  updateMonitoringRuleStatus: vi.fn(),
}));

import * as api from "./monitoring-api";
import { MonitoringRuleManager } from "./monitoring-rule-manager";
import { NotificationCenter } from "./notification-center";

const definition = {
  kind: "inventoryThreshold" as const,
  metric: "inventory" as const,
  operator: "below" as const,
  threshold: 5,
  scope: "allProducts" as const,
  productIds: [],
  frequency: "daily" as const,
};

describe("监听规则管理", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.listMonitoringRules).mockResolvedValue({ items: [] });
  });

  it("先预览 AI 理解结果，再由用户确认创建", async () => {
    vi.mocked(api.previewMonitoringRule).mockResolvedValue({
      suggestedName: "低库存提醒",
      definition,
      evaluation: {
        matched: true,
        periodStart: "2026-09-03T00:00:00.000Z",
        periodEnd: "2026-09-03T23:59:59.999Z",
        matches: [
          {
            resourceType: "SKU",
            resourceId: "sku-1",
            title: "库存低于阈值",
            message: "无线蓝牙耳机当前库存 4 件",
            severity: "WARNING",
          },
        ],
      },
    });
    vi.mocked(api.createMonitoringRule).mockResolvedValue({ rule: ruleView() });

    render(<MonitoringRuleManager open onOpenChange={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("监听内容"), {
      target: { value: "库存低于 5 件时提醒我" },
    });
    fireEvent.click(screen.getByRole("button", { name: "生成预览" }));

    expect(await screen.findByText("AI 理解为")).toBeInTheDocument();
    expect(screen.getByText("当前有 1 项命中")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "确认创建" }));
    await waitFor(() =>
      expect(api.createMonitoringRule).toHaveBeenCalledWith({ name: "低库存提醒", definition }),
    );
  });

  it("删除规则前要求二次确认", async () => {
    vi.mocked(api.listMonitoringRules).mockResolvedValue({ items: [ruleView()] });
    vi.mocked(api.deleteMonitoringRule).mockResolvedValue();
    render(<MonitoringRuleManager open onOpenChange={vi.fn()} />);

    fireEvent.click(await screen.findByRole("button", { name: "删除低库存提醒" }));
    expect(screen.getByRole("alertdialog", { name: "删除监听规则" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "确认删除" }));
    await waitFor(() => expect(api.deleteMonitoringRule).toHaveBeenCalledWith("rule-1"));
  });
});

describe("通知中心", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.syncMonitoring).mockResolvedValue({
      evaluatedRules: 1,
      createdNotifications: 1,
      failedRules: 0,
    });
    vi.mocked(api.getMonitoringUnreadCount).mockResolvedValue({ count: 1 });
    vi.mocked(api.listMonitoringNotifications).mockResolvedValue({ items: [notification()] });
  });

  it("进入看板后同步到期规则并显示未读提醒", async () => {
    vi.mocked(api.markMonitoringNotificationRead).mockResolvedValue({
      notification: { ...notification(), readAt: "2026-09-03T01:00:00.000Z" },
    });

    render(<NotificationCenter />);
    expect(await screen.findByText("1", { selector: ".notification-badge" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "通知，1 条未读" }));
    expect(await screen.findByText("无线蓝牙耳机当前库存 4 件")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "标记低库存提醒为已读" }));
    await waitFor(() =>
      expect(api.markMonitoringNotificationRead).toHaveBeenCalledWith("notification-1"),
    );
  });

  it("标记已读失败时保留通知并显示安全错误", async () => {
    vi.mocked(api.markMonitoringNotificationRead).mockRejectedValue(new Error("database secret"));
    render(<NotificationCenter />);
    await screen.findByText("1", { selector: ".notification-badge" });
    fireEvent.click(screen.getByRole("button", { name: "通知，1 条未读" }));
    expect(await screen.findByText("无线蓝牙耳机当前库存 4 件")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "标记低库存提醒为已读" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("标记失败，请稍后重试");
    expect(screen.getByText("无线蓝牙耳机当前库存 4 件")).toBeInTheDocument();
    expect(screen.queryByText("database secret")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "通知，1 条未读" })).toBeInTheDocument();
  });

  it("同一条通知提交期间禁用重复标记和全部已读", async () => {
    let resolveRead:
      | ((value: { notification: ReturnType<typeof notification> }) => void)
      | undefined;
    vi.mocked(api.markMonitoringNotificationRead).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRead = resolve;
        }),
    );
    render(<NotificationCenter />);
    await screen.findByText("1", { selector: ".notification-badge" });
    fireEvent.click(screen.getByRole("button", { name: "通知，1 条未读" }));
    const readButton = await screen.findByRole("button", { name: "标记低库存提醒为已读" });

    fireEvent.click(readButton);
    fireEvent.click(readButton);

    expect(api.markMonitoringNotificationRead).toHaveBeenCalledTimes(1);
    expect(readButton).toBeDisabled();
    expect(screen.getByRole("button", { name: "全部已读" })).toBeDisabled();

    resolveRead?.({
      notification: { ...notification(), readAt: "2026-09-03T01:00:00.000Z" },
    });
    await waitFor(() =>
      expect(screen.queryByText("1", { selector: ".notification-badge" })).toBeNull(),
    );
  });
});

function ruleView() {
  return {
    id: "rule-1",
    name: "低库存提醒",
    definition,
    status: "ACTIVE" as const,
    lastRunAt: null,
    nextRunAt: "2026-09-04T00:00:00.000Z",
    lastErrorCode: null,
    lastErrorMessage: null,
    createdAt: "2026-09-03T00:00:00.000Z",
    updatedAt: "2026-09-03T00:00:00.000Z",
  };
}

function notification() {
  return {
    id: "notification-1",
    ruleId: "rule-1",
    ruleName: "低库存提醒",
    title: "库存低于阈值",
    message: "无线蓝牙耳机当前库存 4 件",
    severity: "WARNING" as const,
    resourceType: "SKU" as const,
    resourceId: "sku-1",
    periodStart: "2026-09-03T00:00:00.000Z",
    periodEnd: "2026-09-03T23:59:59.999Z",
    readAt: null,
    createdAt: "2026-09-03T00:05:00.000Z",
  };
}
