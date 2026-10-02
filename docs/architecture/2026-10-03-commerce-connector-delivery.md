# Phase 1.2 CommerceConnector Contract Delivery

2026-10-03：获批的 CommerceConnector 契约阶段已完成，分支 `feat/commerce-connector`。所有代码、独立审查修复和测试门禁均已提交；工作目录保留在 `C:/Users/harry/.codex/worktrees/tenant-foundation/aiShopASAS`。

1. **Goal**：实现平台无关的 13 方法 CommerceConnector port、严格的运行时 schema，以及读取、分页和验证响应的安全解析函数。
2. **Why this is needed**：后续 Mock 和真实平台 adapter 可以消费同一套经营数据契约，明确金额单位、数据未知、租户边界、写入结果及回读证明。
3. **Current architecture impact**：保持现有模块化单体；只扩展 `@shopmate/contracts`。实例绑定 Organization / Workspace / Store / Connection 和 externalStoreId；query/command 不接受租户覆盖。没有新增 adapter、Factory、API endpoint、执行服务或 UI。
4. **Files changed**：新增 `packages/contracts/src/commerce/` 的 common/data/action schema、port、validation helpers 和六个测试文件；修改公共 `src/index.ts`、contracts typecheck 脚本、一个既有 dashboard-insight 测试 fixture；新增实施计划和本交付说明。完整差异：`git diff f4ab8c9..HEAD --stat`。
5. **Database changes**：无 migration、表结构、seed 或数据库访问变更。
6. **Security considerations**：strict objects 拒绝额外字段和凭据；外部 ID 保持有界字符串、拒绝 C0/C1/隐形控制字符；文本规范化 Unicode/换行，作为普通数据处理。金额为非负安全整数分、库存写入为绝对目标；写入带执行 ID、幂等键和更新前置条件。失败只返回标准 code，不回传平台原文或 Zod issue。分页核对店铺、limit、游标前进和时间截止；验证核对执行 ID、店铺、资源、kind 和原请求预期。schema 校验不能证明 ownership 或批准写操作。
7. **Privacy/compliance considerations**：契约不包含消费者电话、地址、邮箱等字段，测试只用合成数据；自由文本仍可能包含平台提供的敏感内容，不能据此声称已经完成 PII 检测/脱敏。未读取原项目 `.env`、接入真实商家数据或调用平台/Jev/LLM。沿用已确认的中国大陆部署、跨境传输默认关闭边界；本阶段只实现技术契约，没有宣称全面合规。
8. **Tests added**：新增 112 项契约测试，覆盖精度/strict scope、经营金额关系、未知数据质量、状态矛盾、写入三态、假验证、跨店铺响应、分页及时间边界、执行关联、Unicode 排序、C1 控制字符和公共包导出。全仓回归共 1,124 passed；另有 9 项既有 opt-in API 测试未启用。全部 contracts 测试也纳入 TypeScript 检查。
9. **How to manually verify**：在上述 worktree 运行 `pnpm --filter @shopmate/contracts test`、`pnpm --filter @shopmate/contracts typecheck`；应分别得到 348 passed 和成功退出。运行 `pnpm test` 查看全仓回归；运行 `pnpm build` 查看下游构建及 27 个浏览器产物检查。本轮无 UI 改动，不需要截图验收。
10. **Risks / limitations**：目前为可执行契约，尚无 Mock/真实 adapter、可信 Factory、网络超时/取消执行或写操作审批。能力声明不保证 provider 幂等和并发前置条件。仍需 adapter 校验具体资源引用/筛选条件、正确映射时间和状态、取得新鲜回读。9 项既有真实数据库/平台 opt-in API 测试未启用；本轮未重跑 Phase 1.1 隔离 PostgreSQL 专用测试或远程 GitHub CI。分支尚未合并、推送或部署。
11. **Next recommended step**：实现 Phase 1.3 Mock 源状态、合成数据关系、确定性业务时钟和 Connector conformance tests，再接同步服务；授权与安全截止时钟继续使用真实时钟。随后推进决策层和 ActionEngine，避免直接从 UI/LLM 执行平台写入。
12. **Git commit message**：独立提交四块契约、每项审查修复、全测试类型门禁和交付文档。主要消息为 `feat(contracts): expose validated commerce connector boundary`；详细记录见下文与实施计划。

## Verification evidence

| 检查                                             | 实际结果                                                               |
| ------------------------------------------------ | ---------------------------------------------------------------------- |
| 根 Node tests                                    | 23 passed                                                              |
| contracts 全量                                   | 27 files / 348 passed；本阶段新增 112                                  |
| database 默认离线测试                            | 37 passed；Prisma validate/build passed                                |
| API 本地回归                                     | 61 files passed / 4 skipped；428 passed / 9 skipped                    |
| Web 单元测试                                     | 49 files / 288 passed                                                  |
| 根 lint / typecheck                              | passed；contracts 生产代码和全部测试文件都检查                         |
| 根 format:check / secret:scan / git diff --check | passed                                                                 |
| contracts / database / API / Web build           | passed；27 client bundles 兼容性检查 passed                            |
| 生产函数长度                                     | TypeScript AST 检查 58 个函数，最长 28 行，均小于 40 行                |
| 独立只读复审                                     | 六项问题全部关闭；16 个独立运行时探针通过，无剩余 Critical / Important |

`pnpm test` 在最终生产代码提交 `9c917b8` 上通过。之后只有既有测试 fixture 的类型修正和测试类型门禁扩大；该 fixture 的 20 项测试及扩大后的全仓 typecheck 也通过。构建和浏览器检查使用最终生产代码；本轮没有对原项目环境或经营数据库执行命令。

## Contract semantics and adapter obligations

所有公开类型和 schema 从 `@shopmate/contracts` 根入口导出，不依赖平台 SDK。13 个方法包含八个读取方法、四个写入方法和一个 verifyAction；每次调用必须有 requestId / deadlineAt，可选 AbortSignal 为运行时参数，不属于 JSON metadata schema。

未来 adapter 必须执行以下边界：

1. 从可信 TenantContext 与数据库 ownership 建立 binding；Factory 验证 Store/Connection 是否属于同一租户。不能接受调用者自行提交的 scope 作为授权证据，也不能将绑定 ID 当凭据。
2. 对未知 query / command / JSON call metadata 使用对应 schema；AbortSignal 由服务器调用链提供。使用真实时钟执行 deadline/取消检查，Mock 的业务时钟不能延长安全 deadline。
3. 读取输出经过 `parseConnectorRead` / `parseConnectorPage`。单实体 helper 只核对外部店铺，因此 getProduct/getOrder adapter 还须核对请求资源 ID；列表 adapter 还须实施 since 下界、SKU 选择、营销日期范围及去重/游标策略。外部 ID 必须参数化或 URL 编码，不直接拼接 SQL/URL。
4. 分页 `source.updatedAt` 与 sourceWatermark 的已知值不得晚于 `min(until, observedAt)`；未知 source 时间必须有 `SOURCE_TIME_MISSING`。这不证明 provider observation 新鲜，也不证明历史版本完整，后续 conformance tests 必须验证确定性快照和完整分页。
5. 映射金额为 CNY 安全整数分。订单 discount 是各行折扣之和；订单层折扣需先正确分摊。未知支付/退款分别标记 `PAYMENT_UNKNOWN` / `REFUND_UNKNOWN`；成本、库存、营销缺失也有专门标签。零与未知 null 的含义不同。
6. 归一化 PAID/FULFILLED/COMPLETED 的已知支付应等于应付；缺支付时间需 `PAYMENT_UNKNOWN`。状态/金额矛盾只能作为 `PARTIAL + SOURCE_INCONSISTENT` 保留。未来计算/决策必须识别这些质量标记，不能将其直接当完整财务证据。
7. 写操作仍需服务端权限/审批、预条件、审计与幂等控制。库存使用 targetAvailable；ACCEPTED 只是回执。UNKNOWN 不能盲目重试；provider 不支持原子前置条件时，READ_THEN_WRITE 能力也不能承诺并发安全。
8. verifyAction 进行新鲜、独立回读，然后调用 `parseConnectorVerification(binding.externalStoreId, originalQuery, unknownResponse)`；响应必须带一致 executionId，原请求应从可信执行记录取得。该 helper 核对 kind / SKU / warehouse / product / expected values 和实际状态，不能代替真实回读或证明某一次平台请求已执行。
9. 失败日志和遥测只使用安全上下文；本契约失败响应无原始 payload。输出到 UI 时按文本转义；向 LLM 提供数据时隔离数据与指令。自由文本规范化不是 HTML sanitizer、敏感信息扫描或提示注入防护。

现阶段 CNY / `Asia/Shanghai` 是明确的产品边界；尚无跨币种、负库存或多平台状态映射。本阶段测试没有把真实平台返回、网络事件或权限判定替换成虚假的已交付能力。

## Commit ledger

- `01f884d`：获批契约边界与实施计划。
- `661f5d1`：scope、能力、读取协议与分页 primitives。
- `f356e56`：规范化经营数据及金额/质量校验。
- `3b64480`：绝对写命令、三态回执与独立验证 schema。
- `a290995`：13 方法 port、安全读取/分页解析器、公共 exports。
- `7d2aebe`：支付未知时仍校验已知退款上限。
- `918b0b5`：冻结嵌套预期目标，防止异步期间修改。
- `06ebb5e`：C1 控制字符过滤与普通描述换行归一。
- `6688220`：不依赖 locale 的确定性商品状态比较。
- `a919fd8`：拆分未知支付和未知退款质量标记。
- `6c50ee4`：状态/金额矛盾必须有明确来源质量标签。
- `1a8f1ba`：记录/水位不能超出同步截止和页面观测时间。
- `9c917b8`：执行 ID、店铺、资源和原预期共同绑定验证响应。
- `2b6d290`：修正旧 fixture 类型并将全部 contracts 测试纳入 typecheck。

每项功能与修复均为独立、可验证提交；没有自动 merge、push 或部署。
