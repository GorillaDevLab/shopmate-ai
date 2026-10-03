# 持久演示会话交付记录（Phase 2.3）

分支 `feat/demo-commerce-sessions`，起点为已合并 main `6bfb39e`。本记录覆盖 GitHub 代码与验证；部署和线上迁移由用户完成。

## 1. Goal

持久保存合成店铺配置、业务时间、连接 generation，提供已认证的创建、查看、时间推进、重置和断开 API，并把实际 MockConnectorFactory 接到数据库权限与持久时钟。

## 2. Why

此前 Factory 只有访问端口，时钟与配置由调用方在进程内提供。现在重启后可以恢复同一配置和时间，每次读取重新检查当前店铺、成员权限、连接状态与演示标记；重置后的旧 Connector 不能继续读。

## 3. Architecture impact

`DemoCommerceModule` 注册到实际 AppModule。`DemoCommerceConnectorHost` 每次打开选定店铺创建独立 PersistentMockClock、数据库 resolver 与实际只读 Factory。resolver 每次调用读取当前成员和会话，验证配置、绑定、版本、hash，再刷新业务时钟。

业务时钟只负责模拟经营时间。会话验证、请求 deadline 与取消仍使用真实时间。未新增 source paging API、平台源持久状态、同步 worker、场景引擎或界面；这些是后续单元。

## 4. Changed files

- contracts：demo 控制命令/视图严格 schema，OWNER/ADMIN 的 `demo:manage` 权限。
- database：Prisma public/demo 多 schema、四张新表、复合 FK、强制 RLS、事务仓储与真实数据库回归。
- API：demo-commerce 控制器、服务、数据库适配器、环境/Origin guard、配置 readback 校验、时钟/resolver/host。
- 测试与 CI：强制 PostgreSQL HTTP/Factory 门禁、受限角色 fixture、demo 仓储格式检查。Vitest fixture 留在 test/helpers，不进入生产构建。

## 5. Database

新增 migration `20261003040000_demo_commerce_sessions`：public.DemoTenant、public.PlatformConnection、demo.DemoCommerceSession、demo.DemoControlAudit。现有对象显式留在 public，旧 migration 不修改，迁移后的 Prisma diff 为空。

Store/connection/session/audit 的组织、工作区、店铺与连接关联由复合 FK 约束；连接与会话的归属不可修改。DemoTenant 和数据库 DEMO 标记只能由操作员设置。应用使用非 owner、NOSUPERUSER、NOBYPASSRLS 身份。运行时权限：

```sql
GRANT USAGE ON SCHEMA public,demo TO approved_demo_runtime;
GRANT SELECT ON public."Store",public."Organization",public."OrganizationMember",
  public."Workspace",public."WorkspaceMember",public."DemoTenant",public."TenantBootstrapEnvironment"
  TO approved_demo_runtime;
GRANT SELECT,INSERT,UPDATE ON public."PlatformConnection",demo."DemoCommerceSession"
  TO approved_demo_runtime;
GRANT SELECT,INSERT ON demo."DemoControlAudit" TO approved_demo_runtime;
GRANT EXECUTE ON FUNCTION demo.has_store_access(TEXT,TEXT,TEXT,BOOLEAN) TO approved_demo_runtime;
```

角色名为运维示例，实际由用户另行配置。本单元不授予 schema CREATE、标记写入、审计 UPDATE/DELETE 或会话/连接 DELETE。迁移身份与运行时身份分离。

## 6. Security

所有控制要求有效签名会话、`APP_ENV=demo`、`ENABLE_DEMO_MODE=true`、合法显式 `APP_ORIGIN`、数据库 DEMO 标记及操作员批准的 DemoTenant。管理还要求数据库当前 OWNER/ADMIN；Cookie 的旧权限提示不授予管理权限。NODE_ENV=production 的演示构建可以使用，APP_ENV=production 不放行。

POST 仅接受唯一且匹配的 Origin；跨站标记被拒绝，不信任请求 Host。路径、命令和返回记录严格校验，拒绝请求指定租户/连接归属。配置由可信 Store 和服务端 UUID 组成，规范化后计算 SHA256；JSONB 键序不会破坏 hash。

参数化事务设置 LOCAL 身份。CAS 冲突返回 409。所有七个状态/审计 SQL 写入必须影响恰好一行；中途 RLS 拒绝或实际零行写入会抛出事务内冲突，完整回滚后才返回 CONFLICT。审计只追加，和状态同事务提交。权限、标记、取消或 deadline 的变化不能在迟到查询后启动源读取。

## 7. Privacy

当前只处理合成经营配置及内部身份 ID。不存消费者 PII、平台 token 或完整经营 payload 到控制审计，不调用真实抖店、Jev 或外部模型。公共视图不返回完整配置、租户身份或密钥。

## 8. Tests

- 全仓 `pnpm test`：1,560 passed；9 项既有可选 API 数据库测试仍跳过。
- 强制隔离 PostgreSQL `pnpm test:tenant`：82 passed、零跳过（迁移 2、租户仓储 13、demo 仓储 32、真实 HTTP/Factory 35）。
- lint、typecheck、format:check、secret:scan、build、补充 DB/fixture 格式检查均通过。
- 23 个变更生产 TS 文件、107 个函数体均少于 40 行。

关键证据：真实受限数据库角色、FORCE RLS、身份事务清理、跨租户/未授权工作区拒绝、当前角色降级、CAS 并发单赢家、时钟与 generation 溢出、零行 SQL 的完整回滚、追加审计、重启配置恢复、旧 Connector/游标撤销、两店铺交错时钟隔离、Origin 和严格输入及错误脱敏。服务端单元不需要 UI 截图。

## 9. Manual verification

部署配置和操作员准备完成后，使用有效登录会话：

1. POST `/api/v1/demo-commerce/stores/:storeId/session`，提交严格 settings 与 observedAt；随后 GET 检查公开视图。
2. POST `/advance`，带当前 expectedRevision 和 durationMs；同 revision 重试应 409。
3. POST `/disconnect`，带 expectedRevision 和准确 confirmSessionId；POST `/reset` 还必须提交 settings 与 observedAt。确认错误应 400 且没有状态/审计变化。
4. 同 Cookie 降为 VIEWER 后，合法工作区只读仍允许，管理应 403；撤销成员/工作区或标记后应 404/读取拒绝。
5. 分别打开两店铺，推进其中之一；另一店铺时间与数据保持独立。重置后旧 Connector 返回 AUTH_EXPIRED，重新打开才能读取新 generation。

## 10. Risks and limits

当前只持久配置、业务时钟、连接及控制审计。平台生成数据仍在只读 Connector 中重建；分页 frame/cursor 为进程内、有期限。同步任务、场景、可变平台写入和全链行动审计尚未交付；时间推进不等于规范业务库已同步。旧业务 API 的生产身份完善仍按总路线验收。

已有线上迁移 `20261003030000_tenant_compatibility_hardening` 的 P3009 失败记录需要用户部署前处理。本地已复现受限迁移身份会被拒绝，未读取线上数据库角色。用户核对旧事务与独立迁移身份后再恢复，不提升应用身份的 RLS 绕过权限。本次没有线上迁移或部署操作；已有 main 部署 workflow 的结果不代表本单元已上线。

## 11. Next

提交并附加 PR，远程最新 CI 与审查通过后按授权合并，保留分支/worktree。继续只读故障注入、独立平台源持久状态、因果场景和同步恢复；预期事件/Agent 推理只保留为测试 oracle。

## 12. Commit message

契约、环境/Origin、持久时钟、模型/RLS、原子仓储、零行回滚修复、控制 API、真实 resolver、强制 HTTP 门禁和 CI 格式检查分别提交。交付文档单独提交：`docs(demo): record persistent session delivery and migration requirements`。
