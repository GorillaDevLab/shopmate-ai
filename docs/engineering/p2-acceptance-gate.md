# P2 持久源与五流同步验收门禁

本记录把 `P2-GATE` 映射到真实 [Issue #499：持久源与五流同步交付验收](https://github.com/GorillaDevLab/shopmate-ai/issues/499)。实现证据为已合并的 [PR #480](https://github.com/GorillaDevLab/shopmate-ai/pull/480)，其 head 为 `93ca6585103204ef68747d0b842dc6f2ff0df96c`；核验时 main 为 `1ed26e8110766e0948ab8faa3231ade35358b1ed`。[CI run 38226619903](https://github.com/GorillaDevLab/shopmate-ai/actions/runs/38226619903) 在该实现 head 的六项必需检查全部 SUCCESS。此历史证据不替代本映射 PR 自身的审查与 CI。

## 已交付边界

- [CommerceConnector 契约](../architecture/2026-10-03-commerce-connector-delivery.md)定义绑定租户/店铺/连接的严格数据与调用边界；标准经营模型保留整数分、nullable 值、质量 issues 和源版本。
- [持久源运行器](../architecture/2026-10-11-source-worker-delivery.md)按冻结配置和业务时钟生成、追加并发布合成经营事实；[15 个因果场景](../architecture/2026-10-11-scenario-foundation-delivery.md)提供可复现输入，预期事件与 Agent 推理仅作为测试 oracle。
- [同步交付 runbook](../architecture/2026-10-12-sync-runner-delivery.md)记录已发布源 → 同一 Connector → 持久同步任务 → 产品、订单、退款、库存、营销五流标准事实的链路。真实 PostgreSQL 验收覆盖原子页提交、固定窗口/游标恢复、权限与 generation 边界、009 中断、010 重复/延迟原页重放，以及四画像和全部 15 场景链路。

## 已测规模

容量以 runbook 的实际测量为准：成长/问题/成熟画像采用紧凑配置，配置 180 天、2 单/日、6 产品、18 SKU，各 540 订单；这不是默认画像规模。完整四画像本机验收约 31.6 分钟。

新店默认量单独通过验收：配置 180 天、实际经营 14 天、6 单/日、60 产品、180 SKU、66 订单/订单行、1 退款、180 库存、14 营销和 1,098 源事件，最近一次约 115 秒。此前 100 单/日、五天经营加五天结算的源基准为 4,666 事件、约 413 秒。以上测量不能证明默认成长画像 180 单/日贯穿 180 天或 365 天的容量；默认 60 产品/180 SKU 和各画像数据量保持不变。长历史初始构建仍需后台预热。

## 正式关闭条件

Issue #499 当前 OPEN 时，`P2-GATE` 继续 blocked。仅在本验收映射 PR 获得独立审查、其最新精确 head 的以下六项检查全部成功、合并到 main，并以 completed 状态关闭 #499 后，现有外部门禁校验才可放行：

1. `质量门禁`
2. `历史源与同步验收 (growing)`
3. `历史源与同步验收 (problematic)`
4. `历史源与同步验收 (mature)`
5. `历史源与同步验收 (new)`
6. `15 场景源与同步验收`

映射遵循[敏捷状态同步的外部门禁校验](agile-state-sync.md)，不更改依赖、验证规则或工作流。本记录只验收上述 P2 范围，不验收 P3 Metric Engine 的 adapter、扩展或 replay 接线，也不代表 P4、Jev/LLM、真实平台或审批执行完成。App 配置与初始化仍单独未完成；部署、线上迁移、受限登录与 grant 初始化留待后续统一执行。
