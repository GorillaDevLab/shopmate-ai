# Phase 1.1 Tenant Foundation Delivery

2026-10-03：已实现并在隔离 PostgreSQL 16 验证；分支 `feat/tenant-foundation`。尚未合并、推送或部署。

1. **Goal**：完成获批的 Phase 1.1：Organization、成员、Workspace、可信 TenantContext 和资源权限策略，保留 Merchant 兼容。
2. **Why this is needed**：为后续 CommerceConnector、Mock commerce 和决策层建立明确的 ownership；新租户 API 不再凭 Cookie 中的旧权限授权。
3. **Current architecture impact**：Nest 模块化单体保持现状；新增 TenantModule。全局 MerchantScopeGuard 验证会话后，TenantContextGuard 每次查询当前成员/工作区授权。角色与资源访问在同一个参数化 SQL statement snapshot 中判定，transaction-local 身份在提交或回滚后清理。
4. **Files changed**：共享契约 `packages/contracts/src/tenant/`；数据库 schema、4 个增量 migration、membership/bootstrap 模块及测试；`apps/api/src/tenant/` 与 HTTP 测试；独立测试 runner、Vitest 配置、CI PostgreSQL 服务；本说明和实施计划。完整差异用 `git diff 5e39cf6..HEAD --stat` 检查。
5. **Database changes**：新增 Organization、OrganizationMember、Workspace、WorkspaceMember、TenantBootstrapEnvironment；Merchant 唯一映射组织，回填默认工作区，但不授予任何 user membership。Store 关联同一商家的 Organization/Workspace；Sku→Product、OrderItem→Order/Sku 增加复合商家 FK。旧写入由 trigger 补齐新增字段。迁移先检查既有坏关联并原子停止。新租户四表启用 SELECT-only FORCE RLS；没有 runtime membership 写入 policy。较长的 legacy key 使用独立命名空间中的 SHA-256 派生短标识，Merchant ID 保留。
6. **Security considerations**：严格 ID/schema、工作区 header/path 校验、拒绝 body/query 覆盖；无会话 401、非法选择 400、缺成员/跨组织/未分配/停用统一 404、数据库错误安全 503。旧 Cookie permissions 不升权。Store definer trigger 使用固定 search_path、限定表名、禁止 PUBLIC 直接执行，且要求实际拥有 RLS bypass 的独立 provisioning owner。应用角色不应拥有表或继承 provisioning role。Bootstrap 默认 dry-run、独立 client、环境/数据库标记校验，不修改已有角色或停用状态。
7. **Privacy/compliance considerations**：验证只使用临时合成数据；未读取原项目 `.env` 或连接现有经营数据库。未新增真实抖店、Jev 或真实 LLM 调用。当前交付是租户技术控制的一部分；完整隐私、数据留存、跨境及生产身份流程尚待后续实施和法律审查，不能宣称已全面合规。
8. **Tests added**：新增 24 契约测试、6 service 测试、19 fixture HTTP 测试、3 bootstrap gate 测试，以及必跑的 25 项真实 PostgreSQL/API 测试（2 migration paths + 13 database checks，含父测试 + 10 restricted-role HTTP tests）。合计本阶段新增 77 个测试。全部验证明细如下；旧 seed 在隔离 DB 实际执行成功。
9. **How to manually verify**：运行 `pnpm test:tenant`；查看两组织访问、成员降级/撤销、RLS 缺身份及连接池清理结果。独立演示 DB 初始化和两个 GET endpoint 的操作见下文。所有已运行测试的数据库均由测试 runner 创建/销毁或为明确命名的隔离库。
10. **Risks / limitations**：旧 commerce endpoints 仍沿用 Merchant scope；全量 commerce RLS/context 切换、生产身份、用户邀请、组织管理写 API 尚未交付。默认 bootstrap 不授予用户成员身份，未配置时新 Tenant API 返回 404。现有 deploy workflow 不执行 migration，不能直接靠合并/重启发布本变更。迁移需要具备 RLS bypass 的 provisioning identity。未运行真实平台、LLM 或远程 GitHub CI；9 个既有 opt-in API 测试未启用。无 UI 改动，因此未做截图验收。
11. **Next recommended step**：先验收 Phase 1.1 和迁移权限；随后进入 CommerceConnector 契约及 Mock 源状态设计。完整生产身份与旧 commerce 隔离仍是接入真实商家数据前的发布门槛。
12. **Git commit message**：已按独立变更提交；主要提交包括 `feat(contracts): define tenant scope and resource permissions`、`feat(database): add tenant foundation and legacy ownership constraints`、`feat(tenant): resolve protected contexts from current memberships`、`feat(tenant): add guarded demo membership bootstrap`、`test(tenant): run real API isolation with a restricted database role` 和 `ci(tenant): require PostgreSQL isolation regression`。审查修复和迁移/seed 回归分别独立提交，完整记录见实施计划。

## Verification evidence

| 检查                                             | 实际结果                                                             |
| ------------------------------------------------ | -------------------------------------------------------------------- |
| 根 Node tests                                    | 23 passed                                                            |
| contracts                                        | 21 files / 236 passed                                                |
| database 默认离线测试                            | 37 passed；Prisma validate/build passed                              |
| API 全量本地回归                                 | 61 files passed、4 skipped；428 passed、9 skipped                    |
| Web 单元测试                                     | 49 files / 288 passed                                                |
| `pnpm test:tenant`                               | 25 passed、0 skipped；真实 PostgreSQL 16、实际 Prisma migrate deploy |
| DB unavailable / remote host / URL host override | 3 个预期失败均返回非零，不 skip                                      |
| 根 lint / typecheck / format:check / secret:scan | 全部通过                                                             |
| contracts/database/API/Web build                 | 全部通过；27 个 Web client bundles 兼容性检查通过                    |
| Prisma migration diff                            | 空差异；新库与旧数据升级路径通过                                     |
| 只读独立审查                                     | 三项 Important 问题修复并复核关闭，无剩余 Critical/Important         |

以上合计 1,037 个测试通过；另有 9 个既有 API 测试未启用。Windows checkout 的 CRLF 已在工作目录归一为 LF；没有引入无关文件内容改动。

两个最初启动调试留下、已停止的临时 PostgreSQL 目录清理被自动审批拒绝（`blocked by policy`），因此保留。
后续 runner 的测试实例正常停止并清理；代码、原数据库及测试结果不受影响。

## Isolated database/API regression

在工作区根目录执行：

```powershell
pnpm test:tenant
```

Windows 默认使用安装在 `C:/Program Files/PostgreSQL/16/bin` 的 PostgreSQL；也可用 `PG_BIN` 指向本机二进制。runner 创建临时集群、随机端口和合成数据库，结束后停止并删除自己的目录，不接触其他实例。

Linux CI 使用 PostgreSQL 16 service，显式配置 `TEST_DATABASE_URL`。可接受的外部测试地址仅为 loopback 的 `shopmate_tenant_test` 或其小写字母/数字后缀库；URL query/hash 被拒绝。必须使用一次性的空库和可创建测试角色/数据库的测试 operator。runner 在空库检查失败、PostgreSQL 不可用、任何 SQL/API 测试失败时返回非零，不会改为 skip。它创建的 runtime role 只有新租户表 SELECT 权限，既非 superuser 也无 BYPASSRLS。

## Migration and deployment procedure

仅操作员执行，不作为应用启动动作。本轮没有在原项目或生产库执行以下步骤。

1. 确认目标环境、备份与恢复方案，并在副本上执行 migration/seed 回归。保持应用 `DATABASE_URL` 与 migration/provisioning 凭据分离；凭据通过环境或 secret manager 注入。
2. 使用独立 provisioning identity 执行 `pnpm --filter @shopmate/database prisma:migrate:deploy`。第四个 migration 明确检查该 identity 的 superuser/BYPASSRLS 能力；`inherit_store_tenant()` 归属于该身份。它只做 Store ownership lookup，不提供成员授权入口。
3. 用最小权限应用角色运行 API。该角色不可拥有新表、不能继承/SET ROLE 到 provisioning role、不能创建 schema 对象；已有 commerce 表权限仍按当前应用需要单独管理。
4. 对新租户表仅授予读权限。例如由 operator 执行下列固定 SQL；认证凭据另外通过环境/安全管理配置。

```sql
CREATE ROLE shopmate_tenant_app LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE;
GRANT USAGE ON SCHEMA public TO shopmate_tenant_app;
REVOKE CREATE ON SCHEMA public FROM shopmate_tenant_app;
GRANT SELECT ON "Organization", "OrganizationMember", "Workspace", "WorkspaceMember"
  TO shopmate_tenant_app;
```

5. 对明确的独立合成演示库，operator 可将 `TenantBootstrapEnvironment` 的 singleton 标记设为对应的 `LOCAL`、`TEST` 或 `DEMO`。migration 初始值是 `UNCONFIGURED`；真实生产应标记 `PRODUCTION`，bootstrap 始终拒绝生产。不要把生产库改名或改标记来绕过限制。
6. 演示 bootstrap 完成后，验证已授权与未授权请求，再发布应用。旧 Cookie、Merchant ID 与 UI DTO 保持兼容；新 metadata API 需要显式 membership。

若 preflight 返回 `Legacy ownership conflict`，停止发布并人工调查，不能删除 FK 或静默把商品/订单改到另一租户。新 schema 是 additive；代码回退不应直接删租户列、表或 FK，数据回退需单独审核和恢复验证。

当前自动 deploy workflow 没有 migration 步骤，因此本分支交付供本地审查；发布必须先完成上述 operator 流程。完整生产身份和旧 commerce 隔离完成前，继续使用合成经营数据。

## Demo membership bootstrap

该工具仅用于 loopback 的 `shopmate_tenant_local`、`shopmate_tenant_test`、`shopmate_tenant_demo` 或其小写后缀库。它读取显式环境变量，不自动加载项目 `.env`。

以下示例的 DB URL 由安全环境注入；user/merchant 必须与已验证演示会话匹配。数据库标记须已由 operator 设为 DEMO。

```powershell
$env:APP_ENV = 'demo'
$env:TENANT_BOOTSTRAP_USER_ID = 'demo-user'
$env:TENANT_BOOTSTRAP_MERCHANT_ID = 'demo-merchant'
$env:TENANT_BOOTSTRAP_ROLE = 'VIEWER'
pnpm --filter @shopmate/database tenant:bootstrap

# 审阅 dry-run 输出后，显式执行；重复执行不增加成员或改变已有角色/状态。
$env:TENANT_BOOTSTRAP_APPLY = 'true'
pnpm --filter @shopmate/database tenant:bootstrap
Remove-Item Env:\TENANT_BOOTSTRAP_APPLY
```

默认角色为 VIEWER；OWNER 等角色必须显式指定。已有不同角色或 inactive 成员/工作区授权会失败，管理角色变更须使用以后专门的受审计管理流程。Bootstrap 使用独立 client，并在成功或失败后关闭连接，避免误用 API 的缓存连接。

## HTTP verification

- `GET /api/v1/tenant/context`：使用现有已签名会话 Cookie，返回当前 DB role/permissions 和默认 Workspace。
- `GET /api/v1/tenant/workspaces/:workspaceId`：返回已获授权的工作区标识及组织标识。
- 可选 `X-Workspace-Id` 必须合法且与路径一致；重复、空白或非法 ID 返回 400。
- Cookie 未改的情况下，降级成员角色后重新请求应返回新权限；停用成员/组织/工作区返回同样的安全 404。
- OWNER/ADMIN 可访问组织工作区；其他角色需要 ACTIVE WorkspaceMember。请求另一组织工作区或未分配工作区应返回 404。
- body/query 不接受 scope/role/permission 输入。组织和成员写入没有公共 API。

具体请求使用现有登录获取的 Cookie；不要将 Cookie、数据库凭据或真实商家内容写入日志/提交。
