# Mock 只读故障注入交付记录（Phase 2.4a）

分支 `feat/mock-connector-failures`；起点为已合并 main `6bfb39e`。本单元提供可调用的真实 Connector 包装器，后续在当前 main 上完成全仓验证、PR 与合并；部署由用户另行执行。

## 1. Goal

按服务端规则为八个只读方法注入限流、授权过期、暂时故障、无效响应、真实超时及可取消读取延迟。

## 2. Why

同步恢复必须面对实际失败和时限。确定性规则供恢复测试复用；不会直接向 Event Engine 或 Agent 注入经营结论。

## 3. Architecture impact

`ReadFaultInjectingConnector` 包装实际只读 `CommerceConnector`。业务时钟决定规则是否生效；真实 CallGate 决定超时、取消和最长 30 秒预算。访问与规则加载完成后再次检查取消与 deadline，迟到结果不能启动基础读取。单个规则按优先级降序、ID 的代码单元顺序升序胜出。

## 4. Changed files

新增 `apps/api/src/integrations/mock/failure-rules.ts`、`read-fault-connector.ts` 及两个 spec；本方案和交付文档。现有基础 Connector、源生成器、领域模块与契约不改动。

## 5. Database

本单元没有 migration、持久规则或运行时管理 API。规则由已绑定会话的服务端加载器提供，不能从读取请求中选取策略。后续源宿主再接入持久规则。

## 6. Security

所有读取先校验请求和 UTC 规范化范围，再检查当前权限、加载规则、选择故障。使用基础 `canonicalMockTime` 的纯校验能力，避免非法日期被故障规则遮蔽；查询仍保留基础契约允许的 UTC 年 0000，规则激活时间限制为 0001–9999。规则最多 32 条、ID 唯一、方法不重复、窗口开始包含且结束不包含。字段严格白名单；错误不回显规则或输入。

包装器拒绝支持写入、幂等或写前置条件的基础实例，不增加能力。四个写入方法与 verification 原样交给只读基础适配器拒绝，不生成执行 ID、UNKNOWN receipt 或验证证明。

## 7. Privacy

仅合成经营数据；不接真实平台、消费者资料、Jev 或外部模型。不记录完整业务 payload、凭证或用户请求内容。

## 8. Tests

实际 Mock 专项：203 tests passed / 10 files，其中规则引擎 38、包装器 60，既有基线 105。类型检查、指定文件 ESLint、Prettier、diff 检查通过；生产函数最大 24 行、无 TypeScript any。全仓验证与远程 CI 以最终 PR 结果为准。

关键回归覆盖实际基础读取、固定快照分页、源不变、规则排序与窗口、权限撤销、异常脱敏、迟到加载、真实延迟/超时/取消清理、只读写入拒绝，以及跨 UTC 日历边界输入优先拒绝。失败测试记录在独立报告：引擎初始 38 失败、包装器初始 24 个功能缺失断言失败；日期修复实际 16 失败后 60 全通过。

## 9. Manual verification

用实际 `MockCommerceConnector`、业务时钟、当前权限回调和服务端规则加载器构造包装器。空规则应返回相同经营事实；RATE_LIMIT 返回限定 retryAfter；DELAY 可被 AbortSignal 中止；TIMEOUT 必须等真实 deadline，业务时间快进不能释放请求。非法分页日期应直接返回 INVALID_INPUT，且不调用权限、规则加载或基础读取。

## 10. Risks and limits

不计故障命中次数，不拥有基础实例 dispose 生命周期。宿主必须在权限回调中拒绝过期/撤销会话，并保留与释放基础实例。opaque cursor 的真实性、查询匹配与已过期游标检查由基础分页器在实际委派读取时处理。INVALID_RESPONSE 是标准失败，尚未注入原始坏记录；同步隔离坏记录、平台源中断、延迟写可见性和写成功后丢响应在后续单元验收。

## 11. Next

持久平台源与规则控制、15 个因果场景，以及同步宿主的重试、去重、乱序保护和 freshness。业务 oracle 继续只留在测试和 benchmark。

## 12. Commit message

独立提交：`feat(mock): select deterministic read failure rules`；`feat(mock): inject cancellable read failures into real connector`；`fix(mock): validate UTC query range before read fault selection`。文档单独提交，保留分支与 worktree。
