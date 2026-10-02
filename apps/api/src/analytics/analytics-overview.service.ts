import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from "@nestjs/common";
import {
  ANALYTICS_OVERVIEW_MAX_DAYS,
  AnalyticsDashboardQuerySchema,
  AnalyticsOverviewResponseSchema,
  type AnalyticsOverviewResponse,
} from "@shopmate/contracts";
import { getPrismaClient } from "@shopmate/database";

import { AuthPermission, type AuthContext } from "../auth/contracts/index.js";
import { analyticsWindow } from "./analytics-window.js";
import {
  buildAnalyticsOverview,
  previousWindow,
  type OverviewOrder,
  type OverviewWindow,
} from "./analytics-overview.js";

// 与 AI 洞察读取器一致的单次上限，防止超长周期把整库订单读进内存。
const MAX_ORDERS = 20_000;
const SHANGHAI_OFFSET = "+08:00";

@Injectable()
export class AnalyticsOverviewService {
  private readonly logger = new Logger(AnalyticsOverviewService.name);

  async get(context: AuthContext, rawQuery: unknown): Promise<AnalyticsOverviewResponse> {
    if (!context.permissions.includes(AuthPermission.OrdersRead)) {
      throw new ForbiddenException("没有订单读取权限");
    }
    const current = parseWindow(rawQuery);
    const previous = previousWindow(current);
    let orders: OverviewOrder[];
    try {
      orders = await readOrders(context, previous.startDate, current.endDate);
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      this.logger.error("经营分析查询失败", error instanceof Error ? error.stack : undefined);
      throw unavailable();
    }
    return AnalyticsOverviewResponseSchema.parse(buildAnalyticsOverview(current, previous, orders));
  }
}

function parseWindow(rawQuery: unknown): OverviewWindow {
  const query = AnalyticsDashboardQuerySchema.safeParse(rawQuery);
  if (!query.success) throw invalid("请求参数校验失败");
  const window = analyticsWindow(query.data.asOfDate, query.data.startDate);
  if (window.days > ANALYTICS_OVERVIEW_MAX_DAYS) {
    throw invalid(`统计周期不能超过 ${ANALYTICS_OVERVIEW_MAX_DAYS} 天`);
  }
  return window;
}

async function readOrders(
  context: AuthContext,
  startDate: string,
  endDate: string,
): Promise<OverviewOrder[]> {
  const rows = await getPrismaClient().order.findMany({
    where: {
      merchantId: context.merchantId,
      status: { not: "CANCELLED" },
      orderedAt: {
        gte: new Date(`${startDate}T00:00:00${SHANGHAI_OFFSET}`),
        lt: new Date(Date.parse(`${endDate}T00:00:00${SHANGHAI_OFFSET}`) + 86_400_000),
      },
    },
    select: {
      orderedAt: true,
      totalAmount: true,
      store: { select: { id: true, name: true, platform: true } },
      items: {
        select: {
          quantity: true,
          lineAmount: true,
          sku: { select: { product: { select: { id: true, name: true } } } },
        },
      },
    },
    orderBy: { orderedAt: "asc" },
    take: MAX_ORDERS + 1,
  });
  if (rows.length > MAX_ORDERS) throw invalid("数据量超出单次分析上限，请缩短日期范围");
  return rows.map((row) => ({
    orderedAt: row.orderedAt,
    totalAmount: row.totalAmount.toString(),
    store: row.store,
    items: row.items.map((item) => ({
      productId: item.sku.product.id,
      productName: item.sku.product.name,
      quantity: item.quantity,
      lineAmount: item.lineAmount.toString(),
    })),
  }));
}

function invalid(message: string) {
  return new BadRequestException({ statusCode: 400, error: "请求参数无效", message });
}

function unavailable() {
  return new ServiceUnavailableException({
    statusCode: 503,
    code: "ANALYTICS_SERVICE_UNAVAILABLE",
    message: "经营分析服务暂不可用，请稍后重试",
  });
}
