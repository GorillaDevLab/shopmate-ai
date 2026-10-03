# Phase 2.2：只读 MockCommerceConnector 与连接选择边界

分支 `feat/mock-commerce-connector`，基于已合并 Phase 2.1 的 main `92964e4`。本阶段交付 server-only 库；PR 与最新远程 CI 状态在交付回复中提供。保留工作目录供反馈，不自动合并。

1. **Goal**：通过统一 CommerceConnector 读取 Mock 店铺、商品、订单、退款、库存和营销，提供稳定分页、截止时点回放和可信连接选择端口。
2. **Why this is needed**：后续同步与指标需要经过同一 Connector 合约读取事实；扫描期间推进业务时间、重试或撤销权限都必须产生可验证结果。
3. **Current architecture impact**：增加 MockCommerceConnector、CallGate、两帧缓存、有限游标注册表及 MockConnectorFactory。Factory 使用注入的服务端权威 resolver，每次操作重新解析权限和连接代次。尚未注册 Nest module/controller、实际 Prisma resolver 或连接注册表；解析 AuthContext 形状不等于认证，宿主必须从 session guard 获取身份。
4. **Files changed**：`apps/api/src/integrations/mock/` 新增 mock-call、mock-frame-store、mock-cursor-store、mock-page、mock-write、mock-commerce-connector、mock-connector-factory 及四组 specs；共享 connector-common failure schema/spec 增加 NOT_FOUND；本计划与交付文档。
5. **Database changes**：无 schema/migration/seed/数据库写入。真实 Store ownership、成员关系与连接注册表的 resolver 实现留给后续宿主集成；本次测试数据库为临时隔离 PostgreSQL。
6. **Security considerations**：严格请求/身份/返回记录验证，未知字段拒绝；Factory 仅在 demo 环境且显式启用时开放，并核对 resolver 提供的数据库 demo marker、demo tenant、身份和完整 binding。每次读重新检查具体权限和 generation/config fingerprint，旧实例拒绝变更后的连接。游标只定位本实例状态，不能建立授权；方法、窗口、分页大小和 SKU 选择绑定到游标。全部写能力为 false，合法命令返回 REJECTED/UNSUPPORTED，无验证成功证据。异常仅返回标准失败码；真实时间截止、30 秒预算与 AbortSignal 不受业务时钟控制。
7. **Privacy/compliance considerations**：只使用 Phase 2.1 合成经营数据，无消费者 PII、平台凭据、外部 API 或真实 Jev/抖店调用。没有跨境发送；没有读取原项目 .env。代码库授权端口的验证不构成实际部署或合规验收。
8. **Tests added**：新增 55 项：共享缺失资源 1、调用门禁 13、Connector 17、游标 3、Factory 21。覆盖全部端口、历史状态、完整无重漏分页、时间推进与重试、跨方法/查询/实例游标、过期/淘汰、容量上限、SKU 过滤、营销窗口、权限撤销/连接变化、非 demo 拒绝、超时/取消、无状态写拒绝。独立审查发现的错峰游标到期问题已先复现失败，再用 scanId 与整条扫描共同到期修复并复核。
9. **How to manually verify**：运行下方命令；connector spec 中推进 SimulationClock 并重试同一游标，确认 items/observedAt/nextCursor 相同；factory spec 中撤销 resolver 权限或增加 generation，旧实例立即失败。所有样本均为合成配置，不需要 .env 或部署数据库。
10. **Risks / limitations**：实例最多两帧、256 游标，扫描链按真实时间 15 分钟到期；缓存帧淘汰要求重新扫描。同步生成不能被抢占，只能前后检查截止，需置于离线/worker 宿主，未进行 HTTP 吞吐/峰值内存验收。营销 since 必须为上海零时，输出每日累计值，上界可截止到日内，不支持任意日内归因。watermark 仅保守到 historyUntil，不能单凭单页证明同步完整或窗口外需求完整。`mock-v1` 仍为静态夹具标记，所有写/幂等/前置版本能力关闭。缺失 executionId 的写命令会抛 INVALID_INPUT，因为不能伪造关联 ID。Factory 的环境开关在构造时固定；宿主更新环境需重建 Factory。无实际连接持久化、可变运行源、场景/故障注入、同步 DB、指标或 UI。main 部署仍受已有 `20261003030000_tenant_compatibility_hardening` 失败状态 P3009 阻塞；本 PR 没有修复或操作线上迁移。
11. **Next recommended step**：继续补齐 Mock 平台的场景、故障注入与持久 demo 管理；实际 resolver、Store/PlatformConnection 选择与同步宿主需单独落地，仍从服务端会话获取身份。真实平台与 Jev 等待独立批准。
12. **Git commit message**：计划、共享失败码、调用门禁、只读 Connector、Factory、审查回归修复和交付文档分别提交。主要提交 `feat(mock): implement read-only commerce connector`、`feat(mock): select connectors through fresh tenant access`，修复提交 `fix(mock): isolate restarted cursor chains and share scan expiry`。

## 操作语义

- 时间窗口：until 规范化为 UTC 并裁剪到当前业务时间；历史读取重新生成该时点的状态，不从未来状态筛选。Sync since 按 source.updatedAt 包含下界；营销 since 按上海日历过滤。
- 已不存在/尚未出现/外店 ID：统一 NOT_FOUND。未知或错配游标：INVALID_INPUT；过期或帧淘汰：CONFLICT；dispose 或 generation/config 变化：AUTH_EXPIRED。权限取消：PERMISSION_DENIED。
- 续页：使用固定帧，整条链共享到期时间；新扫描使用独立 scanId，不复用旧扫描后续游标。FIFO 游标淘汰保持父游标早于后续游标淘汰。
- 权威 resolver：输入是已认证服务端身份、selected storeId 和带截止/取消的 ReadOptions；返回当前 `{context, config, generation, environmentMarker, demoTenant}`。查询数据库、验证 Store 归属和确认连接有效属于宿主责任，不能让 HTTP body 提供该记录。
- 所有 13 个 CommerceConnector 方法均实现，但写入及 verifyAction 明确不支持。只有读能力为 true。

## 离线验证

```powershell
pnpm test
pnpm test:tenant
pnpm lint
pnpm build
pnpm typecheck
pnpm format:check
pnpm secret:scan
pnpm --filter @shopmate/api exec vitest run src/integrations/mock
```

生产 build 与 Web typecheck 顺序执行，避免并发覆盖 Next 生成类型。没有新增依赖、数据库表或公开路由。当前 mock suites 共 105 项（含 Phase 2.1 的 51 项）；独立审查无未解决 Critical/Important 问题。

## 验证记录

- 最终全仓 `pnpm test`：Node 23、contracts 360、database 44、API 643、Web 221，共 **1,291 passed**；9 项既有 opt-in API 测试 skipped。
- 隔离 PostgreSQL：新库迁移/旧库升级/RLS/受限 HTTP 身份 **25 passed、0 skipped**；合计 **1,316 passed**。
- 全仓 lint/typecheck/format/secret scan 通过；build 通过，31 个浏览器产物兼容检查通过。游标修复后 API 重新构建、相关类型和 Lint 检查通过。
- AST：8 个变更生产 TS 文件，96 个函数/方法/箭头函数，最长 22 行，无 any；游标修复后再次检查函数长度。
- 最新 main 部署失败状态核对：[Deploy Tencent Cloud](https://github.com/GorillaDevLab/shopmate-ai/actions/runs/37092079446)，已有 P3009；这是部署状态，不能用 PR CI 通过替代上线验收。
