# K4 看板组件管理设计

## 目标

在不重写 K3 拖拽与缩放能力的前提下，让用户能够读取自己的服务器布局，在本地草稿中新增或删除现有组件，预览结果，并显式保存、放弃修改或恢复默认布局。保存失败与并发冲突不得丢失草稿。

本阶段只覆盖 Issue #117。AI 查询 DSL、饼图与报告组件属于 K5；监听规则属于 K6；跨用户隔离与完整端到端覆盖属于 K7。

## 现状

- K2 已提供受认证保护的 `GET/PUT /api/v1/dashboard/layout`。
- 布局按 `userId + merchantId` 隔离，并使用 `expectedRevision` 做乐观并发控制。
- K3 编辑器支持原生拖放排序、四档宽度和键盘调整，但只维护内存中的默认布局。
- 合约当前允许四类组件：指标、销售趋势、库存提醒和热销商品，最多 24 张卡片。

## 方案

采用“领域 reducer + 现有编辑器渐进扩展”。不引入 Zustand、拖拽库或动画库，也不改变 K3 的布局语义。这样可以把服务器基线、用户草稿、编辑模式和保存状态集中管理，同时保持本 PR 的范围可审查。

### 状态模型

```ts
type LayoutEditorState = {
  baseline: DashboardLayout;
  draft: DashboardLayout;
  revision: number;
  mode: "view" | "edit" | "preview";
  loadStatus: "loading" | "ready" | "error";
  saveStatus: "idle" | "saving" | "saved" | "error" | "conflict";
  removedCard?: RemovedCardSnapshot;
};
```

`baseline` 始终代表最后一次成功读取或保存的服务器布局；`draft` 是当前界面使用的布局；`isDirty` 由二者比较得到。失败、超时和 409 冲突只更新状态与错误信息，不覆盖草稿。

### 数据流

1. 编辑器加载时读取布局并用共享 Zod Schema 校验响应。
2. 读取成功后同时设置 `baseline`、`draft` 和 `revision`。
3. 新增、删除、排序和缩放只更新 `draft`，不调用后端。
4. 预览模式继续渲染 `draft`，但隐藏所有编辑控件。
5. 显式保存时发送 `{ layout: draft, expectedRevision: revision }`。
6. 保存成功后用响应覆盖 `baseline`、`draft` 和 `revision`，退出编辑模式。
7. 保存失败或冲突时保留草稿并允许重试。冲突提示用户重新加载服务器版本会丢弃本地草稿。

客户端不接受或提交 `userId`、`merchantId`。身份继续由认证 Cookie 和服务端 `MerchantContext` 注入。

## 组件与交互

### 编辑工具栏

编辑模式提供“添加组件”“预览”“完成并保存”，其余低频操作放入 More Menu：

- 放弃修改：恢复到 `baseline`。
- 恢复默认：二次确认后将默认布局写入草稿，仍需显式保存。

保存期间禁用重复提交。未保存草稿存在时注册 `beforeunload` 提醒。

### Widget Gallery

Gallery 只列出当前合约支持的四类组件，并展示简短预览。新增组件使用受控工厂生成默认配置与唯一 ID；达到 24 张上限时禁用新增。

指标组件允许选择四个指标键。其他组件使用合约定义的安全默认配置。Gallery 不接受任意 JSON，也不生成或执行代码。

### 删除与撤销

卡片 More Menu 提供删除。删除后卡片从草稿移除，页面底部显示 4 秒 Undo toast；撤销会按原索引恢复完整卡片配置。新的删除操作会替换之前的撤销快照。

### 预览

Preview 是草稿的只读表现：隐藏拖拽、缩放、删除和新增入口，但不保存、不改变服务器基线。用户可返回编辑继续修改。

## 错误处理

- 401：提示会话失效并提供重新登录入口。
- 400：显示布局校验失败，不发送未经 Schema 验证的数据。
- 409：显示“其他设备已更新”，保留草稿，并提供重试或重新加载服务器版本。
- 503/网络错误：显示可重试错误，保留草稿。
- 初始读取失败：不允许在未知 revision 上保存，提供重新加载。

错误信息使用可访问的 `role="status"` 或 `role="alert"`，不依赖颜色传达。

## 文件设计

新增：

- `apps/web/src/app/dashboard-layout-api.ts`：读取、保存、响应校验和分类错误。
- `apps/web/src/app/dashboard-layout-api.test.ts`：API 请求与错误测试。
- `apps/web/src/app/dashboard-layout-state.ts`：reducer、dirty 比较、受控组件工厂和撤销逻辑。
- `apps/web/src/app/dashboard-layout-state.test.ts`：领域状态测试。
- `apps/web/src/app/dashboard-widget-gallery.tsx`：Gallery 与组件预览。
- `apps/web/src/app/dashboard-widget-gallery.test.tsx`：Gallery 交互测试。

修改：

- `apps/web/src/app/dashboard-layout-editor.tsx`：接入 API/reducer，新增保存、预览、删除、撤销和恢复流程。
- `apps/web/src/app/dashboard-layout-editor.test.tsx`：覆盖 K4 关键路径。
- `apps/web/src/app/dashboard.tsx`：保持 AI 助手与布局弹层互斥。
- `apps/web/src/app/globals.css`：Gallery、菜单、确认弹层、保存反馈和 Undo toast。
- `apps/web/src/app/responsive-a11y.test.tsx`：375px 和可访问名称验证。

共享 contracts 与后端 API 已满足 K4，不做无关改动。只有实现过程中发现现有 Schema 无法表达受控新增时，才提交最小合约修订并同步测试。

## 可访问性与响应式

- 所有菜单、对话框、按钮和删除操作具有可读名称。
- 对话框打开后管理初始焦点，关闭后归还触发元素。
- Escape 关闭 Gallery、预览或确认弹层，不丢失草稿。
- 375px 下 Gallery 使用底部抽屉，操作按钮保持至少 44px 触控区域。
- `prefers-reduced-motion` 下只使用短 opacity 过渡。

## 验证

分三个检查点执行：

1. API 与 reducer：Web 单元测试、TypeScript、Lint。
2. Gallery 与编辑器：Web 单元测试、TypeScript、Lint。
3. 样式与集成：完整 Web 测试、Build、Secret Scan，以及 Playwright 桌面端和 375px 视觉检查。

验收场景包括读取服务器布局、新增、删除与 Undo、预览、放弃、恢复默认、保存、刷新恢复、网络失败保留草稿和 409 冲突保留草稿。
