# P3–P13 Agile Task Pool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement one claimed task at a time. The user has reserved P3 onward for two human developers; this plan does not authorize an agent to claim or implement their tasks automatically.

**Goal:** 把 Phase 3–13 的已批准产品范围拆成每张 1–4 小时、可领取、可独立验证和评审的任务。

**Architecture:** 先发布契约，再用依赖注入与仅测试使用的合成夹具并行实现组件。持久化、实际 API/页面接线和跨领域验证拥有明确前置依赖。阶段编号表示产品归属，不强迫全部工作串行；P9 审计写入和 P10 outbox 等基础能力须提前支持业务事务。

**Tech Stack:** TypeScript、Zod/contracts、NestJS、Next.js/React、Prisma/PostgreSQL、Vitest、Playwright、GitHub Issues/Projects。

## Global Constraints

- 每卡工时为实现、定向验证、PR 准备的人工估算，取值 1、2、3、4 小时，不是交付时间承诺。
- 一个任务一个 `feat/`、`add/` 或 `fix/` 分支和 PR；每个细小、独立且可验证的改动单独一个 commit。
- 函数、测试回调、SQL 函数体均小于 40 行；TypeScript 禁用无理由的 `any`。
- 输入严格验证并 sanitize；环境变量存储密钥；SQL 参数化；API 默认认证，完整租户 scope 来自可信身份与严格解析。
- UI 最小断点 375px；加载、空、错误三态；破坏性操作二次确认；保持现有设计系统。
- P2 尚未交付的实际数据、同步和因果夹具用外部 `P2-GATE` 表示，不能假设已经存在。固定公共契约和运行手册合并后才能关闭该门槛。
- P2 publication 基础关闭已发布 inclusive frontier，未提供 command writers。P8 Mock 写入必须等待 P08-033..040 的独立 requestRevision、receipt-backed same-tick chronology、冻结前缀/immutable certificate 与 readback gate；P2-GATE 不能代替这些动作扩展。禁止直接 UPDATE immutable source/Runtime、假造时间或推进 1ms，规范库仅经同步收敛。
- 当前只用合成数据。真实 Douyin/Jev/LLM 调用、服务器部署、线上迁移、真实商家数据接入不在本任务池执行授权内。
- 钱使用币种明确的最小单位整数；时区、期间、定义版本、质量状态和证据不能省略。缺数据不能显示为精确零。
- 人类审批绑定可信、可撤销的会话与不可变提案版本/哈希/TTL。Agent、Rules、目标均无审批权限。
- UNKNOWN 写入结果先查询回执/实际状态，禁止盲重试；补偿作为新提案重新审批。
- 审计在实际业务变更原事务写入；通知依赖仅 IN_APP 收件人 outbox/dedup/cooldown。ACTION_DISPATCH/ACTION_VERIFY 使用独立 typed durable job 契约、表和幂等键；reservation/outcome/job/audit 同事务，dispatchIntent 一次派发，UNKNOWN 只回读，有限 attempt/deadline/lease/fence。QA 预期答案不可进入生产推理或决策。

## 阅读入口

- [机器可读任务池](p3-p13-agile/backlog.json)：ID、工时、契约、输入输出、文件、依赖、验收、测试、范围边界。
- [分阶段任务索引](p3-p13-agile/README.md)：每阶段的可读任务卡与统计。
- [GitHub Project](https://github.com/orgs/GorillaDevLab/projects/1)：Backlog、Ready、In progress、In review、Done。
- [GitHub Issues](https://github.com/GorillaDevLab/shopmate-ai/issues?q=is%3Aissue%20label%3Aagile-p3-p13)：以任务 ID 查找，一卡一 Issue，按 phase/lane/estimate 标签和 Phase milestone 筛选。
- 执行依据：[产品架构](../../architecture/2026-10-03-production-mock-review.md)、[DecisionProvider 架构](../../architecture/2026-10-03-decision-provider-design.md)。

## 并发与领取

1. 只领取标为 `agile:ready`、没有负责人、硬依赖已合并的任务。优先从不同 `parallelGroup` 各取一张。
2. 在 Issue 自分配，刷新确认 Assignee 只有自己，再将状态改为 In progress、标签改为 `agile:in-progress`。每人同时最多一张。
3. Issue 留下领取记录：负责人、起始 main SHA、分支、预计完成时间、锁定文件。若同时领取形成多个 Assignee，先由协调人确认一个负责人；其他人换卡，确认前都不开工。原生 Assignee 不是原子抢锁，本协议靠确认避免撞任务。
4. 组件可使用已合并契约与本地测试夹具交付；`integrationDependsOn` 仅规定真实接线的门槛，不能被夹具“通过”替代。组件 PR 需明确其验证范围。
5. `files` 是当前卡拥有的文件；`sharedFiles` 是共享变更锁。共享 schema、根导出、模块注册、页面入口均按对应文件锁短时串行合并。每张契约卡必须在同一 PR 持 contracts-index（packages/contracts/src/index.ts）共享锁发布公共 root exports，不能推迟到运行集成卡；不同契约文件的设计/编辑/fixture验证仍可并行。运行时根模块与路由注册由指定 integration 卡负责。数据库 store 公共导出同理在 producer PR 持 database-index 锁发布。新文件名为拟定路径，可在保持归属范围后更名，并同步任务卡。
6. 后续卡必须基于最新 main。发现范围超过 4 小时，先把独立剩余交付拆为后续卡并更新依赖，不能扩大本卡验收或静默积累大 PR。
7. 卡片数据是初始计划，实际 PR 发生契约/路径调整时同 PR 更新任务池，协调人重新校验受影响依赖和归属。删除需求需先记录产品理由。

领取记录示例（将字段替换为实际值后提交）：

```text
领取 P03-001
负责人：GitHub 登录名
起始 main：实际 SHA
分支：feat/p03-001-metric-contract
预计完成：本次工作时段结束时间
独占文件：本卡 files
共享锁：本卡 sharedFiles；没有则写“无”
```

## Ready 与完成门槛

`dependsOn` 表示开始和独立验收前必须合并的任务；`integrationDependsOn` 表示实际连接生产路径前必须合并的任务。`P2-GATE` 由 P2 完成验收关闭。真实接线卡的硬依赖闭包必须包含已消费叶子的全部 integrationDependsOn，以及明确的实际 metric/Agent/auth/upload/parser/strategy/source 实现门槛；缺少任一实现不能 Ready。组件用 fixture Done 只代表接口交付。初始仅无硬依赖的卡标 Ready；依赖合并后由协调人检查文件锁，再将后继卡放 Ready。此版本不声称自动解析依赖或自动原子领取。

每卡的统一交付步骤：

- [ ] 确认已领取、依赖、输入输出和文件锁；核对当前 main 的真实接口。
- [ ] 对卡内指定的成功、拒绝/错误、质量边界先编写失败用例，确认失败原因有效。
- [ ] 只实现卡内交付；每个独立改动写清晰 commit message 并单独提交。
- [ ] 运行卡内定向测试与改动对应的 lint/typecheck/build；UI 卡提供 375px 与桌面截图/键盘验证。
- [ ] PR 使用 `Closes #Issue编号`，列出结果、测试证据和范围限制，经过独立 review。
- [ ] 确认最新 PR head CI 全绿，合并 main，关闭 Issue，状态设 Done；未合并不能算 Done。

## 优先拉通的两个轨道

- 第一轮可由两人分别领取 P03-001 指标契约和 P09-001 审计契约。其他阶段契约/离线研究也可提前领取，按 Ready 队列择优。
- 指标契约合并后，经营公式与质量/证据组件可以分文件并行。审计契约合并后，脱敏、追加写入和租户证明可并行推进至可接入门槛。
- P4–P13 的纯组件/UI 可以依契约开发；实际事件流水、审批、执行、通知、发布仍分别依赖审计、身份、outbox、Mock 写入和 readback。
- 全阶段不等于每张卡都能此刻同时开工；当前 Ready 集合及逐卡依赖是领取依据。

## 交付说明

**Goal / Why:** 支持两位开发者按任务池持续领取，减少同文件冲突、隐含依赖和超过半天的大任务。

**Architecture / Files:** 本次仅增加计划、任务数据、阶段卡及归属/依赖检查证据；运行时产品逻辑不变。

**DB:** 不执行迁移；数据库卡拥有独立 SQL 文件，Prisma schema 变更受共享锁与集成依赖控制。

**Security / Privacy:** 不发布密码、连接串、真实商家经营数据；不改变仓库/Project 的 private 可见性、不邀请或赋权协作者。

**Tests / Manual:** 计划阶段仅静态验证。未来真实 PostgreSQL 证明必须由每张拥有测试的卡持 runner/config 锁注册精确 nested DB 或 API 目标；API 使用 `test/**/*.e2e-spec.ts`，tenant include/default exclude。pnpm test:tenant 清除继承开发 DATABASE_URL，仅注入 isolatedPostgres disposable lifecycle 产生的 TEST_DATABASE_URL/runtime DATABASE_URL；零选择、零执行或 skip 均失败并确保 finally stop。嵌套 DB 测试不能依赖默认 test/\*.test.mjs。校验唯一 ID、Phase 3–13 覆盖、1–4h、依赖存在/无环、文件归属、验收和测试字段；核对 GitHub Issue 数、标签、milestone、Project 自动加入和 Ready 队列。

**Risks:** 契约卡完成前叶子组件不能假装已有真实接口。1–4h 为单卡估算；数据库隔离/并发证明可能暴露新工作，应重新拆卡。手动领取必须刷新确认唯一负责人。

**Next:** 先完成 P2 并记录 P2-GATE 验收；P3 onward 由两位开发者领取，本代理不自动认领。

**Commit messages:** `docs(plan): define P3-P13 agile claim and delivery workflow`; `docs(plan): add bounded phase task cards and dependency map`。
