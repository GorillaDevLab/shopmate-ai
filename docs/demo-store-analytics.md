# 多门店/多渠道演示数据

这是合成数据，不是淘宝、抖音、小红书 API 接入。每个商家 6 个网点、30 个商品、60 个 SKU、180 天内 3000 笔订单；共两个商家用于隔离验证。

## 无数据库预览

```powershell
pnpm --filter @shopmate/database seed:analytics --as-of=2026-09-13
```

日期必须显式指定，通常选择展示当天的上海日期。默认 dry-run 只打印数量，不连接数据库。

## 导入（仅由操作者确认独立演示数据库后执行）

先检查 DATABASE_URL 指向专用演示数据库，做好备份。以下命令会写数据库，开发过程中没有执行。

```powershell
pnpm --filter @shopmate/database prisma:migrate:deploy
pnpm --filter @shopmate/database build
$env:DEMO_DATABASE_WRITE = 'isolated-demo-only'
pnpm --filter @shopmate/database seed:analytics --as-of=2026-09-13 --apply
Remove-Item Env:DEMO_DATABASE_WRITE
```

导入使用事务与固定 ID upsert，不清空数据库。相同日期重跑不累计订单；更换日期会移动这批演示订单的时间，不保留历史演示快照。操作范围为 analytics-demo-a / analytics-demo-b 专用命名空间。

原演示商家不被替换。需要在专用演示环境将 API 的 DEMO_AUTH_MERCHANT_ID 配置为 analytics-demo-a，重启并重新登录。不要更换真实用户的商家权限。第二商家 analytics-demo-b 用于独立账号隔离测试。

## 可演示的问题

- 最近 30 天各门店销售额占比。
- 最近 30 天淘宝、抖音渠道的订单量对比。
- 北京朝阳店最近 30 天哪些商品销量最高？
- 最近 90 天各渠道客单价。

仍使用受限 DSL 和现有 AI 饼图/报告入口。门店目录来自当前认证商家，模型不能提交 merchantId。渠道筛选枚举为 OFFLINE、TAOBAO、DOUYIN、XIAOHONGSHU。门店/渠道查询只计 PAID 订单；库存仍为当前快照。无商品筛选/分组时销售额使用订单总额（包含订单级优惠）；商品归因使用明细金额，商品筛选下客单价为匹配明细金额除以匹配订单数。

最多 366 天、20000 笔候选订单，超出会拒绝而非截断计算。图表最多显示所选 limit 个分组，报告最多 8 项。目录最多提供 100 个网点，当前演示只有 6 个。

## 页面交互

- 左侧导航集中提供经营看板、AI 助手和经营监听，桌面可收起，小屏使用展开菜单。
- AI 图表可在柱状图和环形图之间切换，不重复请求模型。门店/渠道对比默认柱状图，其余查询默认环形图。
- 客单价等平均指标仅显示柱状对比，不将平均值相加计算占比。
- 切换显示方式仅影响当前组件，不保存到布局；查询与数据仍沿用兼容的 pie/report 合同。现有销售趋势折线图保留。
- 组件库支持长预览滚动，底部输入及添加按钮可达。

## 尚未包含

- 真实平台数据同步、利润/广告 ROI/复购/退款净额。
- 自然语言生成时间序列折线图的新合同，以及任意 SQL 执行。
- 生产数据库迁移、真实数据库导入与数据库集成验证、付费模型验证。

发布顺序：迁移 → 生成 Prisma Client 并构建 API → 导入确认的演示数据 → 配置演示商家 → 重启。旧订单 storeId 保持 NULL，显示未分配门店。
