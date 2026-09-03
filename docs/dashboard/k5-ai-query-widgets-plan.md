# K5 AI 查询 DSL 与饼图报告组件实现计划

> 设计依据：`docs/dashboard/k5-ai-query-widgets-design.md`

## 目标

在现有认证 AI Chat、Analytics Service 和 K4 看板草稿编辑器上增加受限经营查询 DSL、可扩展字段注册表、饼图与报告卡片。聊天生成组件时直接加入草稿并可撤销；组件库生成时先预览；只有用户显式保存才持久化。

## 实施原则

- 每个行为先补失败测试，再写最小实现使其通过。
- LLM 和客户端均不得提供 `userId` 或 `merchantId`。
- 查询执行只调用白名单领域服务/Repository，不解释或拼接 SQL。
- 共享契约使用严格 Zod Schema，禁止未知字段。
- 布局兼容已有 version 1 数据，并把新保存布局规范化为 version 2。
- 报告只渲染纯文本与结构化数组。

## Task 1：定义查询 DSL、结果和布局契约

**文件**

- 新增：`packages/contracts/src/ai/dashboard-insight.schema.ts`
- 新增：`packages/contracts/src/ai/dashboard-insight.spec.ts`
- 修改：`packages/contracts/src/dashboard/dashboard-layout.schema.ts`
- 修改：`packages/contracts/src/dashboard/dashboard-layout.spec.ts`
- 修改：`packages/contracts/src/dashboard/dashboard-layout-api.spec.ts`
- 修改：`packages/contracts/src/index.ts`

**步骤**

1. 为数据集、指标、维度、聚合、日期范围、筛选、排序、结果上限和可视化类型编写严格 Schema 测试。
2. 覆盖拒绝任意字段、SQL 文本、未知筛选、非法日期、超限结果和身份字段。
3. 定义饼图结果：标题、查询摘要、分片标签、非负数值、单位和空状态。
4. 定义报告结果：标题、摘要、要点和结构化指标，限制字符串长度与数组数量。
5. 定义生成请求与响应，输入只包含自然语言问题及 `pie`/`report` 目标。
6. 把 `pieChart`、`report` 卡片加入 Dashboard 布局契约，配置只保存规范化 DSL 和展示标题。
7. 将布局升级到 version 2，并实现 version 1 到 version 2 的兼容解析函数；验证默认布局仍可复现。
8. 导出新增 Schema 和类型。
9. 运行：`pnpm --filter @shopmate/contracts test`、`typecheck`、`lint`。

## Task 2：实现可扩展字段注册表与查询校验器

**文件**

- 新增：`apps/api/src/ai/insights/dashboard-insight-registry.ts`
- 新增：`apps/api/src/ai/insights/dashboard-insight-registry.spec.ts`
- 新增：`apps/api/src/ai/insights/dashboard-insight-validator.ts`
- 新增：`apps/api/src/ai/insights/dashboard-insight-validator.spec.ts`

**步骤**

1. 测试注册表包含当前销售、商品和库存指标/维度，并声明允许的聚合、筛选、单位和执行来源。
2. 实现只读注册表，禁止重复 key，保持未来平台连接器可扩展。
3. 测试指标与维度不匹配、禁止聚合、非法筛选、过大 limit 和无效日期被拒绝。
4. 实现语义校验器；日期允许任意有效跨度，但限制返回分组和粒度。
5. 确保 DSL 无 `userId`、`merchantId`、表名或 SQL 表达能力。
6. 运行相关单元测试、TypeScript 和 Lint。

## Task 3：实现受限查询执行器

**文件**

- 新增：`apps/api/src/ai/insights/dashboard-insight-executor.ts`
- 新增：`apps/api/src/ai/insights/dashboard-insight-executor.spec.ts`
- 按需修改：`apps/api/src/analytics/sales-query.repository.ts`
- 按需修改：`apps/api/src/analytics/sales-query.repository.spec.ts`
- 按需修改：`apps/api/src/analytics/sales-query.service.ts`
- 按需修改：`apps/api/src/analytics/sales-query.service.spec.ts`
- 按需修改：`apps/api/src/analytics/low-stock.service.ts`
- 按需修改：`apps/api/src/analytics/product-performance.service.ts`

**步骤**

1. 用 mock 领域服务测试执行器始终接收服务端 `AuthContext` 中的 Merchant 范围。
2. 测试销售额/订单量/销量按商品和日期聚合，以及库存按商品/SKU/风险分组。
3. 测试空结果、数据源失败、超时和分组上限。
4. 实现按注册表 source 分发的执行器，不接受可执行字符串。
5. 优先复用现有 Analytics Service；确有缺口时只在 Repository 增加参数化 Prisma 聚合或受控数据读取。
6. 将结果格式化为确定性的饼图或报告结构，金额使用 minor units，避免浮点误差。
7. 运行相关 API 测试、TypeScript 和 Lint。

## Task 4：实现 AI 生成工具和认证预览 API

**文件**

- 新增：`apps/api/src/ai/insights/dashboard-insight.tool.ts`
- 新增：`apps/api/src/ai/insights/dashboard-insight.tool.spec.ts`
- 新增：`apps/api/src/ai/insights/dashboard-insight.service.ts`
- 新增：`apps/api/src/ai/insights/dashboard-insight.service.spec.ts`
- 新增：`apps/api/src/ai/insights/dashboard-insight.controller.ts`
- 修改：`apps/api/src/ai/ai.module.ts`
- 修改：`apps/api/src/ai/tools/tool-registry.ts`
- 修改：`apps/api/src/ai/tools/tool-registry.spec.ts`
- 修改：`apps/api/test/ai-chat.e2e-spec.ts`
- 新增：`apps/api/test/dashboard-insight.e2e-spec.ts`

**步骤**

1. 为 `createDashboardInsight` 工具编写契约与注册测试。
2. 工具输入使用共享 DSL Schema；描述只公开业务字段目录，不公开数据库结构。
3. 服务将问题交给受限 LLM 工具调用，严格解析候选 DSL，通过校验器后执行。
4. 不合法或无工具调用的模型结果返回稳定中文错误，不进入执行器。
5. 添加认证 `POST /api/v1/ai/dashboard-insights/preview`，请求不接受身份字段。
6. 端到端覆盖 401、合法预览、非法模型输出、Merchant 隔离和安全错误。
7. 在 Mock Provider 增加确定性的饼图/报告意图，保证 Demo 和测试不依赖真实密钥。
8. 运行 AI/API 单元与 e2e 测试、TypeScript、Lint、Secret Scan。

## Task 5：扩展聊天响应为可选组件建议

**文件**

- 修改：`packages/contracts/src/ai/chat-api.schema.ts`
- 修改：`packages/contracts/src/ai/chat-api.spec.ts`
- 修改：`apps/api/src/ai/chat/ai-chat.service.ts`
- 修改：`apps/api/src/ai/chat/ai-chat.service.spec.ts`
- 修改：`apps/api/src/ai/agent/business-agent.ts`
- 修改：`apps/api/src/ai/agent/business-agent.spec.ts`
- 修改：`apps/web/src/app/chat-api.ts`
- 修改：`apps/web/src/app/chat-api.test.ts`

**步骤**

1. 测试聊天响应可选携带严格的 `dashboardWidget`，纯文本响应保持兼容。
2. 从 BusinessAgent 已验证工具输出中提取最新组件建议，不从自然语言答案解析 JSON。
3. 验证非法工具输出不会泄露到响应。
4. 更新 Web API 客户端解析及错误覆盖。
5. 运行 contracts、API 和 Web 相关测试。

## Task 6：实现饼图与报告卡片

**文件**

- 新增：`apps/web/src/app/dashboard-insight-api.ts`
- 新增：`apps/web/src/app/dashboard-insight-api.test.ts`
- 新增：`apps/web/src/app/dashboard-pie-chart.tsx`
- 新增：`apps/web/src/app/dashboard-pie-chart.test.tsx`
- 新增：`apps/web/src/app/dashboard-report-card.tsx`
- 新增：`apps/web/src/app/dashboard-report-card.test.tsx`
- 新增：`apps/web/src/app/dashboard-insight-card.tsx`
- 新增：`apps/web/src/app/dashboard-insight-card.test.tsx`
- 修改：`apps/web/src/app/dashboard-layout-editor.tsx`
- 修改：`apps/web/src/app/dashboard-layout-editor.test.tsx`
- 修改：`apps/web/src/app/globals.css`

**步骤**

1. 测试 API 客户端的认证 Cookie、成功、401 和结构错误。
2. 测试饼图的结构化分片、图例、空/加载/错误三态和无障碍摘要。
3. 使用 CSS conic-gradient 或现有轻量图表能力绘制确定性饼图，避免新增重量级依赖。
4. 测试报告标题、摘要、要点、指标与纯文本转义。
5. 实现统一 Insight 卡片数据加载；单卡失败可重试且不阻塞其他卡片。
6. 在编辑器 render 分发、标题、克隆和尺寸逻辑中接入两种卡片。
7. 验证 375px、键盘操作和主题对比度。

## Task 7：实现组件库 AI 预览与聊天直接添加

**文件**

- 修改：`apps/web/src/app/dashboard-widget-gallery.tsx`
- 修改：`apps/web/src/app/dashboard-widget-gallery.test.tsx`
- 修改：`apps/web/src/app/dashboard-ai-assistant.tsx`
- 修改：`apps/web/src/app/dashboard-ai-assistant.test.tsx`
- 修改：`apps/web/src/app/dashboard-layout-state.ts`
- 修改：`apps/web/src/app/dashboard-layout-state.test.ts`
- 修改：`apps/web/src/app/dashboard-layout-editor.tsx`
- 修改：`apps/web/src/app/dashboard-layout-editor.test.tsx`
- 修改：`apps/web/src/app/dashboard.tsx`
- 修改：`apps/web/src/app/globals.css`

**步骤**

1. 先测试生成卡片可以作为完整 `DashboardLayoutCard` 加入草稿，且不会立即保存。
2. 将撤销快照泛化为最近一次可逆新增或删除操作，覆盖新增后撤销和删除后撤销。
3. 组件库为 AI 饼图/报告提供问题输入、生成中、预览、空结果、错误和确认添加状态。
4. Assistant 接收 `onWidgetCreated`；聊天响应携带组件时直接加入草稿并显示“已加入，可撤销”。
5. 非编辑状态收到组件时进入编辑草稿状态；不得绕过 K4 显式保存流程。
6. 覆盖卡片已满、重复 ID、用户删除、放弃修改、预览和保存失败恢复。
7. 运行 Web 单元测试、TypeScript、Lint 和 Build。

## Task 8：兼容迁移、端到端验证与交付

**文件**

- 修改：`apps/api/src/dashboard-layout/dashboard-layout.service.spec.ts`
- 修改：`apps/api/src/dashboard-layout/dashboard-layout.service.ts`
- 修改：`apps/api/test/dashboard-layout.e2e-spec.ts`
- 修改：`tests/e2e/demo-flow.spec.ts`
- 修改：`scripts/check-dashboard-layout.js`
- 按需修改：`README.md`

**步骤**

1. 测试读取旧 version 1 布局时迁移到 version 2，并保持卡片顺序和配置。
2. 测试保存新版查询卡片及 revision 冲突，不改变用户/商家隔离。
3. 增加完整 Demo 流程：登录 → AI 生成饼图 → 自动加入草稿 → 撤销/重新生成 → 预览 → 保存 → 刷新恢复。
4. 增加组件库报告流程：生成预览 → 取消不修改 → 再次生成并添加 → 删除。
5. 运行质量门禁：
   - `pnpm --filter @shopmate/contracts test`
   - `pnpm --filter @shopmate/api test`
   - `pnpm --filter @shopmate/web test`
   - `pnpm --filter @shopmate/contracts typecheck`
   - `pnpm --filter @shopmate/api typecheck`
   - `pnpm --filter @shopmate/web typecheck`
   - 各包 Lint
   - Web Build
   - API 相关 e2e
   - `pnpm secrets:scan`
6. 在桌面与 375px 浏览器中截图复核布局、错误态和键盘流程。
7. 检查 diff 中无 `any`、`console.log`、硬编码密钥、任意 HTML 或身份字段输入。
8. 使用清晰提交拆分 contracts、API、Web 与测试，推送 `feat/k5-ai-query-widgets` 并创建关联 #118 的 PR。

