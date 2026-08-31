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

脚本检查 375px 和 1440px 下内容边界、四项指标、七根趋势柱实际高度及演示按钮禁用状态。
检查内容的真实几何边界，不依靠 `overflow-x: hidden` 掩盖溢出。
浏览器产生的 `.playwright-cli/` 快照和日志仅留本地，不加入提交。

真实数据加载、状态切换及重试由后续 F4 联调完成；当前三态通过组件属性和单元测试验收。
