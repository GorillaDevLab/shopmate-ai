# Dashboard 预览与验收

F1 保留中文经营看板布局和加载、空、错误状态；F2 补充可复用经营指标卡片。不连接真实 Analytics API。

`DashboardPreviewSchema` 位于 `@shopmate/contracts`，是演示界面的共享展示模型；
图柱百分比和展示数据仅供预览，不能用作 E 模块的分析指标定义。
Web 的 `dashboard-data.ts` 导入时通过该 Schema 校验所有预览区域数据。

## 经营指标卡片

`MetricCard` 接收共享 `DashboardMetric`，`MetricGrid` 按固定顺序展示四项指标：

| key               | 展示名称   | value 单位 |
| ----------------- | ---------- | ---------- |
| sales             | 今日销售额 | 人民币分   |
| orders            | 今日订单   | 单         |
| units             | 今日销量   | 件         |
| averageOrderValue | 客单价     | 人民币分   |

- `value` 是非负安全整数或 `null`；金额保留两位小数并加千分位，计数显示中文单位。
- `changeRatio` 是有限比例数或 `null`，例如 `0.186` 为上升 18.6%，`-0.052` 为下降 5.2%。下降最多为 100%。
- 比例由数据提供方计算，卡片不推算客单价或涨跌口径；当前比较文案为“较上一周期”。正式周期及接口映射由 E/F4 确定。
- 变化同时显示箭头、文字和颜色；非零但幅度小于 0.1% 时显示“上升/下降不足 0.1%”。
- `value: null` 显示“暂无数据”，真实 `0` 正常显示；`changeRatio: null` 显示“暂无可比数据”。
- `state` 支持 `ready`、`loading`、`empty`、`error`。加载显示 Skeleton 并尊重减少动画设置；空和错误状态不保留旧数值。缺失的指标显示空卡片。

## 热销与低库存组件（F3）

`HotProductsPanel`、`LowInventoryPanel` 分别接收 `items` 与 `state`，可独立进入加载、空和错误状态。当前首页使用演示数据；真实请求状态由 F4 接入。

- 热销条目含商品名、SKU、上游排名、销量及整数分销售额；保留上游顺序，不自行排序或重算指标。缺失数值显示“暂无数据”，零值正常显示。
- 库存条目含商品名、SKU、剩余库存、近 7 天销量及预测。只格式化传入天数，不做库存除销量计算。
- `forecast.status` 为 `estimated` 时必须提供正数 `days`，显示约一位小数；小于 0.1 天显示“预计不足 0.1 天售罄”。
- `out_of_stock` 显示“已售罄”；`no_sales` 显示“暂无销量，无法估算”；`insufficient_data` 显示“数据不足，无法估算”。这些状态不携带 `days`。
- Schema 拒绝负数、非有限数、重复 SKU 及明显矛盾的库存状态；不替代 E 模块的风险筛选或计算规则。
- 两个列表各有 Skeleton、空态和错误提示，非正常状态不展示旧条目。移除了未实现的“查看全部提醒”占位按钮，本次不新增商品跳转或补货操作。

## 单元测试

```sh
pnpm --filter @shopmate/contracts test
pnpm --filter @shopmate/web test
```

覆盖预览字段边界、实际 Mock 合法性、人民币分位精度、涨跌及零值/空值、中文经营元数据、演示提示和三态展示。
组件测试不具备浏览器布局能力，375px 的验收需要下面的真实浏览器检查。

## 浏览器布局检查

启动 Web 后，在仓库根目录执行（需要 Node.js/npx 和 Chrome）：

```sh
pnpm --filter @shopmate/contracts build
pnpm --filter @shopmate/web dev
```

另开终端执行：

```sh
npx --yes --package @playwright/cli playwright-cli -s=f1-check open http://localhost:3000 --browser chrome
npx --yes --package @playwright/cli playwright-cli -s=f1-check snapshot
npx --yes --package @playwright/cli playwright-cli -s=f1-check run-code --filename scripts/check-dashboard-layout.js
npx --yes --package @playwright/cli playwright-cli -s=f1-check close
```

脚本检查 375px 和 1440px 下内容边界、四项指标、七根趋势柱实际高度、SKU 与库存特殊状态。
检查内容的真实几何边界，不依靠 `overflow-x: hidden` 掩盖溢出。
浏览器产生的 `.playwright-cli/` 快照和日志仅留本地，不加入提交。

真实数据加载、状态切换及重试由后续 F4 联调完成；当前三态通过组件属性和单元测试验收。
