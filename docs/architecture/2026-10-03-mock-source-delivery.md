# Phase 2.1：确定性 Mock 经营源与业务时钟

分支 `feat/mock-commerce-source`，基于已合并 Phase 1.1/1.2 的 main `4b3ef2c`。本阶段完成独立源数据基础；完整 Mock 平台仍按批准路线分阶段推进。

已提交 [PR #204](https://github.com/GorillaDevLab/shopmate-ai/pull/204)，目标 main，已附加到当前聊天；远程 CI 结果以 PR 最新提交的质量门禁为准。未自动合并或部署，保留工作目录供反馈迭代。

1. **Goal**：四画像的可复现源数据、业务时钟、180 日历史事件回放和不可变观测快照。
2. **Why this is needed**：下一阶段 Connector、同步与指标必须读取同一套经营事实，能够验证资金/库存守恒与时点边界，不能依赖静态 JSON 或硬编码 Agent 答案。
3. **Current architecture impact**：新增 API 项目下独立 server-only 纯模块；复用共享 CommerceConnector DTO 的严格 Zod schema。没有注册 Nest module/controller、改现有 reader 或 Web。调用方传入已验证 binding；配置解析不证明资源授权。
4. **Files changed**：`apps/api/src/integrations/mock/` 中 business-clock、mock-config、mock-random、mock-catalog、mock-campaign-plan、mock-history、mock-order、mock-replay、mock-marketing、mock-source、mock-types；四组 specs；本计划与交付文档。
5. **Database changes**：无 schema/migration/seed/数据库写入。本次没有读取原项目 .env 或修改部署数据库。
6. **Security considerations**：严格配置与 binding、未知字段拒绝、uint32 seed、1–365 天、商品/SKU与日单量硬上限、最多 150,000 候选单预算、externalStoreId 最多 200 字符以保留派生 ID 空间。时钟拒绝负数、分数、溢出及规范化后超出 Connector 日期范围的输入，失败不移动时间。业务时钟不控制 session/审批/lease 过期。公开快照深层冻结。
7. **Privacy/compliance considerations**：只合成商品、订单、退款、库存和推广数据；无消费者姓名、电话、地址、匿名消费者关联、凭据、PII 或外部调用。没有真实 Jev/抖店/LLM 接入或跨境发送；本阶段不构成全面隐私/法律合规验收。
8. **Tests added**：51 项覆盖时钟与范围保护、配置/画像/目录、随机流隔离、schema、资金关联、退款上限、库存逐事件守恒、未来事实遮蔽、冻结、hash、跨店命名空间、精确午夜前缀、历史结束后的交易履约和真实缺货。独立审查发现的午夜遗漏与日期规范化问题均经失败回归、修复、复核关闭；补货目标修正也经独立回放复核。
9. **How to manually verify**：执行下方命令；使用同一输入与 asOf 比较 datasetHash；改变 seed 应改变 hash；推进时间核对 ledger 前缀不变。New 仅最后 14 天有经营事实，growing 首个 hero SKU 在末期补货间隔后真实可售库存为 0。使用相同 dailyOrders、不同 adSpendMinor 验证需求受到有限的广告转化模型影响。
10. **Risks / limitations**：生成器是离线同步函数，有 CPU/内存开销，不应直接放入高并发请求路径。快照是固定配置的历史构造，不是持久 DemoSession，不能覆盖未来运行 adapter 的人工写入状态。Source version `mock-v1` 是静态夹具标记，不能拿来声称支持乐观并发；运行 adapter 必须维护真实版本。没有 Connector 实现/Factory、分页/故障注入、15 个场景、源状态持久化、同步 DB、完整 funnel、成本变更/退货成本冲回/归因模型、指标/事件/审批/审计实现；没有利润口径上线验收。营销是有限的每日预算→点击→潜在订单模型，并从实际观测付款汇总归因收入，不是完整真实广告平台。初版每单一种 SKU，全部商品在店铺开业时上架；多行篮子、新品发布、供应延期、坏批次原因证据与数据质量注入属于后续源模型迭代。未解决此前部署的迁移权限/失败状态，不能宣称已上线。
11. **Next recommended step**：Phase 2.2 将此源接入只读 MockCommerceConnector、可信连接选择和 conformance/pagination 测试；运行 source state 要与 fixture 构造分离。随后补齐场景与持久 demo 管理。真实平台/Jev 继续等待独立批准。
12. **Git commit message**：已拆为计划、业务时钟、目录、配置保护、日期保护、历史源与交付文档的独立提交。主要实现提交为 `feat(mock): generate causal historical commerce snapshots`；交付提交为 `docs(mock): record source verification and operating limits`。

## 验证记录

- 全仓 `pnpm test`：Node 23、contracts 359、database 44、API 589、Web 221，共 **1,236 passed**；9 项既有 opt-in API 测试 skipped。
- 新增 Mock suites：4 files / 51 passed。
- `pnpm test:tenant`：临时隔离 PostgreSQL 的迁移/RLS/受限身份 HTTP 测试 **25 passed，0 skipped**；与全仓回归合计 **1,261 passed**。没有连接部署数据库。
- lint、全仓 typecheck、format、secret scan 通过；build 通过，31 个浏览器产物通过兼容检查。
- AST 检查：50 个生产函数/方法/箭头函数，最长 37 行；无 any。
- 独立审查：无未解决 Critical/Important 问题。

本机 Windows / Node 24.14，seed42、2026-01-01 上海零时开始、180天、2026-06-30 上海零时观测、每店60商品180SKU；单次已构建模块生成基准如下。耗时仅是本机测量，不是服务 SLO，也未进行压力或峰值内存验收。

| Profile     | Orders | Refunds | Ledger events | Marketing days | Generate ms |
| ----------- | -----: | ------: | ------------: | -------------: | ----------: |
| growing     | 19,889 |     694 |        44,519 |            180 |       1,029 |
| problematic | 21,031 |   1,348 |        46,995 |            180 |       1,068 |
| mature      | 16,654 |     213 |        37,973 |            180 |         801 |
| new         |     66 |       0 |           488 |             14 |          10 |

## 离线手动验证

```powershell
pnpm --filter @shopmate/contracts build
pnpm --filter @shopmate/api build
pnpm --filter @shopmate/api exec vitest run src/integrations/mock
```

业务调用签名：`generateMockSource(unknownConfig, unknownAsOf): MockSnapshot`；`SimulationClock.snapshot(): BusinessTime`、`advance(durationMs): BusinessTime`。测试中的 config 与 binding 全为合成值，可直接复用。`historyUntil` 表示配置允许的需求历史截止；观测时间可晚于截止，已生成订单的后续付款/发货/退款仍会正常回放，不新增窗口外订单。

环境隔离不是一个配置字段即可实现。本模块无管理入口或 seed 命令；后续注册 demo 控制时必须同时验证 APP_ENV=demo、ENABLE_DEMO_MODE、数据库环境 marker、demo:manage 和 demo tenant。Production 必须拒绝 demo 管理写入。
