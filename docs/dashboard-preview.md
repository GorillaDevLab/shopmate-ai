# Dashboard 预览与验收

F1 保留中文经营看板布局和加载、空、错误状态，不连接真实 Analytics API。

`DashboardPreviewSchema` 位于 `@shopmate/contracts`，是演示界面的共享展示模型；
金额文案和图柱百分比仅供预览，不能用作 E 模块的分析指标定义。
Web 的 `dashboard-data.ts` 导入时通过该 Schema 校验所有预览区域数据。

## 单元测试

```sh
pnpm --filter @shopmate/contracts test
pnpm --filter @shopmate/web test
```

覆盖预览字段边界、实际 Mock 合法性、中文经营元数据、演示提示和三态展示。
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

脚本检查 375px 和 1440px 下内容边界、七根趋势柱实际高度及演示按钮禁用状态。
检查内容的真实几何边界，不依靠 `overflow-x: hidden` 掩盖溢出。
浏览器产生的 `.playwright-cli/` 快照和日志仅留本地，不加入提交。

真实数据加载、状态切换及重试由后续 F4 联调完成；当前三态通过组件属性和单元测试验收。
