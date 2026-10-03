# Mock 持久源身份与代配置交付记录（Phase 2.4b）

分支 `feat/mock-source-storage`，已接入 main #207 `5f56df7`。部署和线上迁移由用户后续执行；远程 CI 与合并结果另记于执行追踪。

## 1. Goal

受限 source worker 从已批准的 Demo Session 初始化不可变代配置；独立 source reader 按当前身份和完整归属读取，重启后保持同一配置与历史基线。

## 2. Why this is needed

持久化因果源需要固定历史配置、开店时间和代身份。后续追加事件不能通过扩大 days 重建并改写旧历史，普通应用也不应直接读取源内部数据。

## 3. Current architecture impact

新增独立 `@shopmate/database/mock-platform` 子路径和 reader/worker 端口；现有应用数据库入口不导出 source client。存储协议 `mock-runtime-v2` 与既有生成器身份 `mock-source-v1` 分开保存。现有 CommerceConnector 与公开管理 API 在本单元保持其既有行为。

## 4. Files changed

数据库 migration/Prisma models、`src/mock-platform/` 中的配置校验/客户端/身份/代仓储、真实 login fixtures 与验证测试、强制数据库测试 runner、CI 格式门槛、方案与 operator 说明。完整操作说明见 `docs/operations/mock-source-generation.md`。

## 5. Database changes

新增 migration `20261003050000_mock_source_generation`：`demo.MockWorkerGrant` 和 `mock_platform.Runtime`。完整复合归属 FK、ENABLE/FORCE RLS、PUBLIC 撤权和 invoker helper；Runtime 的配置/hash/生成器/opening/baseline 不可变。代配置复制当前 Session，原始 SQL 也不能替换这些值。

Migration 创建两个 NOLOGIN 能力组，需要 operator 具备创建角色的权限或预先提供合格能力组。未来部署需单独 migration identity、两种最小权限 source login、各自环境 URL 和 operator 批准的 VIEWER/workspace/grant；不提升应用身份权限。

## 6. Security considerations

worker 主体从实际 login 的 ACTIVE grant 推导，必须维持 VIEWER 和指定 workspace 赋权。reader 按当前人类身份、所选 merchant、组织/工作区/店铺/session/connection/外部命名空间/generation 共同授权。每次调用重查标记、角色和连接；身份设置仅在当前事务生效。

显式 source 环境配置，无 DATABASE_URL fallback；拒绝 owner、BYPASSRLS、危险继承权限、混合 reader/worker 能力及已验证的数据/文件/程序高权限组。严格输入、静态参数化 SQL、错误脱敏。写入后最终访问检查失败时先回滚，再返回 DENIED；零行写入必须验证已存在的相同记录，避免伪成功。

闲置连接断开由内部 listener 记录为脱敏 SOURCE_STORAGE，下一次有效操作报告一次失败，再次显式重试建立新连接并重新授权。借出连接的异步错误使当前事务回滚并销毁连接。listener 不抛错、不保存原始错误；关闭可清理未消费的失败。提交确认丢失时不自动重放操作。

## 7. Privacy/compliance considerations

仅合成经营数据，无真实消费者资料、平台或 Jev 调用。不记录 URL、凭证、SQL 错误 payload。当前单元不改变已确认的中国大陆部署/关闭跨境传输边界；未来真实数据接入仍按独立发布门槛验收。

## 8. Tests added

修复后的强制 PostgreSQL/API 门槛为 106 passed / 0 skipped：migration 2、tenant 13、demo 32、source 24、API 35。Source 专项 29 passed；database package 49 passed。真实 login 覆盖两个组织、同组织多店、双 merchant 用户、角色/marker/连接撤销、复用连接、重启、原始 SQL 伪造、零行写入和不可变触发器。

实际 red/green 修复：DENIED 路径提交一行的回滚问题、混合能力组/pg_write_all_data 身份错误接受、非 UTC 时间错误标注、闲置/借出连接断开使进程退出、非字符串 profile 错误分类。四项实际 reader/worker 后端终止回归验证子进程存活、错误脱敏、新 PID 重连和正常关闭；测试观察实际 error 发出，不增加可掩盖崩溃的错误处理。数据库 UTC 默认与本地事务 UTC 设置均已验证。controller 独立生产 TypeScript AST 检查为 57 functions，最长 33 行。

最终代码的全仓 typecheck、lint、format、secret scan、额外 source/数据库文件格式与 diff 检查均通过。全仓测试 1,663 passed（root 23、contracts 480、database 49、API 890、web 221），既有可选 API 测试 9 skipped；强制数据库/API 的 106 项均未跳过。全仓构建通过，31 个客户端 bundle 兼容性检查通过。任务复审的 spec 和 quality 均通过，原始 Important/Minor 问题关闭；完整分支审查、远程最新 head CI 与合并结果另记于执行追踪。

## 9. How to manually verify

按 operator 说明批准 session、最小 VIEWER 主体和其指定 workspace，配置两种 source 环境 URL。调用 worker.listGrants/initializeGeneration 和 reader.findGeneration：首次 CREATED、重复 EXISTS；关闭并重建 client 后配置/hash/dates 相同。advance 不移动 baseline/opening；reset 后旧 scope 读取为空，新代可独立初始化。撤销 grant/成员/marker/连接后下一次操作拒绝，复用 reader 连接不能沿用另一用户的身份。

## 10. Risks / limitations

本单元保存代配置，尚无持久经营事实、journal/projection、build lease、发布修订、可恢复分页、后台生成或 UI。现有读取源仍使用既有路径。SQL 故障测试证明初始化拒绝后的回滚，不代表已解决发布与 reset/disconnect 的并发排序；下一单元建立真实共享锁和竞态回归。授权在每次操作重新检查，不声称 operator 撤销会等待全部在途事务。

## 11. Next recommended step

共享 source/control 会话锁 → append-only 事实与 fenced 发布 → 持久固定快照分页 → 增量后台因果生成，再继续场景、同步和指标等已批准路线。Phase 2.4 整体仍未完成。

## 12. Git commit message

独立 commits：`feat(database): enforce restricted immutable mock source generations`；`feat(database): add validated mock source reader and worker ports`；`test(database): require mock source generation integration gates`；`fix(database): contain source connection failures and allow explicit recovery`；`fix(database): strictly validate persisted source profiles before insertion`；operator 与交付说明另作 docs commit。保留分支和 worktree。
