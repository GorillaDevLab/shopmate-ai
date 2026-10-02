# Phase 1.1 Tenant Foundation Implementation Plan

状态：实现与验证已完成；产品负责人已批准 Phase 1.1，当前交付待验收。

**Goal:** 建立数据库支持的组织、成员、工作区和可信 TenantContext，兼容现有 Merchant 与 Cookie。

**Architecture:** 全局 MerchantGuard 继续验证旧签名会话。新的 Tenant API 在此基础上每次读取组织/工作区成员关系；新 context 不使用 Cookie 中的 permissions 授权。组织通过唯一 legacy Merchant 映射建立，旧数据关联增加同商家复合约束；不将整个旧 commerce API 的 RLS 切换混入本阶段。

**Tech Stack:** TypeScript、NestJS、Zod、Prisma、PostgreSQL 16、Vitest、Node tests。

## Global Constraints

- 保留既有 Merchant ID、Cookie 格式、商品/看板响应。
- TenantContext 只由服务端已验证 membership 派生，不接受 body/query 的 tenant ID。
- OWNER/ADMIN 可访问组织工作区；其他角色需显式 WorkspaceMember。
- 缺成员、inactive/suspended、跨组织和未获工作区授权统一安全 404。
- 新 Tenant routes 校验当前数据库 role；Cookie 内旧权限不能升权。
- 演示账户不自动获得组织成员身份；需要独立操作员 bootstrap。
- SQL 参数化；密码/Token 不写源码或日志；关键路径测试先失败再实现。
- 每个独立可验证改动单独 commit；无真实平台/Jev调用或无关UI改动。
- 数据库测试只用临时实例或显式命名的 isolated test database，拒绝生产/远程数据库。
- RLS 本阶段覆盖新 Tenant 表；旧 commerce 全量 RLS/context 切换留到下一独立阶段，并明确发布限制。

## Task 1: Tenant schemas and permission policy

Files: packages/contracts/src/tenant/tenant.schema.ts、tenant-policy.ts、两份对应 spec、src/index.ts。

Produces: TenantContextSchema、TenantResourceSchema、TenantRoleSchema、TenantPermissionSchema、
TENANT_ROLE_PERMISSIONS、canAccessTenantResource(context, resource, permission): boolean。

- [x] 先写 schema/权限测试；覆盖 unknown arguments、非法/超长ID、重复permission、同组织/同工作区访问、跨组织、Viewer拒批、Operator默认拒批。
- [x] 红灯命令：pnpm --filter @shopmate/contracts exec vitest run src/tenant
- [x] 实现 strict schema 与纯 policy：

```ts
canAccessTenantResource(context, resource, permission);
// 必须同时满足：
// context.organizationId === resource.organizationId
// resource.workspaceId 缺省或等于 context.workspaceId
// context.permissions 包含 permission
```

- [x] 绿灯、contracts lint/typecheck/test。
- [x] Commit: feat(contracts): define tenant scope and resource permissions

## Task 2: Additive schema, legacy mapping and relation integrity

Files: packages/database/prisma/schema.prisma、新 migration、test/tenant-database.test.mjs、test/helpers/isolated-postgres.mjs、
src/tenant-membership.ts、src/index.ts、package.json。

Produces: Organization、OrganizationMember、Workspace、WorkspaceMember；
Organization.legacyMerchantId 唯一 FK 指向 Merchant；Store 可关联 Workspace；
OrderItem.merchantId 自动继承 Order；Sku→Product 和 OrderItem→Order/Sku 复合 merchant FK。

- [x] 写真实 PostgreSQL 升级/空库测试，在旧迁移后插入两商家商品/订单再应用新 migration：

```js
await assert.rejects(
  client.query('INSERT INTO "Sku" (...) VALUES ($1, $2, $3, ...)', crossMerchantValues),
  (error) => error.code === "23503",
);
```

- [x] 红灯：新表查询失败 / 未有复合约束时错误关联成功。
- [x] 新 migration 回填每 Merchant 对应 legacy organization + default Workspace，不推断任何 user membership。
- [x] 迁移必须检查已有坏关联并事务失败，不静默修正租户。
- [x] AFTER INSERT Merchant trigger 维护旧seed新增商家的 legacy mapping；OrderItem BEFORE trigger 继承/校验 merchant。
- [x] 独立 Prisma repository 函数 resolveTenantMembership(userId, merchantId, workspaceId?) 用身份 scope transaction，参数化 set_config；
      返回 membership/角色/workspace，经域服务建立context。
- [x] PostgreSQL新表SELECT RLS：app.user_id + ACTIVE membership、OWNER/ADMIN或WorkspaceMember；缺身份读空；
      普通app不写tenant membership；migration owner/bootstrap操作员分离。
- [x] 覆盖 inactive成员/组织/工作区、外组织workspace、未分配同组织workspace、missing scope、连接池事务清理。
- [x] prisma validate/generate/build；新迁移增量验证；数据库 tests。
- [x] Commit: feat(database): add tenant foundation and legacy ownership constraints

## Task 3: Resolve memberships and expose protected tenant API

Files: apps/api/src/tenant/{tenant.module,tenant.controller,tenant-context.guard,tenant-context.decorator,
tenant-scope.service,tenant-membership.repository}.ts、对应 specs 与 test/tenant-context.e2e-spec.ts、app.module.ts。

Consumes: Task1 schemas/policy、Task2 resolveTenantMembership。
Produces: GET /api/v1/tenant/context、GET /api/v1/tenant/workspaces/:workspaceId。
默认workspace为legacy default；X-Workspace-Id可选，须严格验证并校验当前身份授权。

- [x] 单元与HTTP红灯测试：未登录401；缺member/跨组织/未分配workspace404；
      header重复/非法/与path不一致400；body/query tenant覆盖404；DB异常503无详情。
- [x] TenantGuard读取全局MerchantGuard已验证userId/merchantId，忽略cookie permission。
- [x] TenantScopeService调用repository，输出冻结TenantContext；tenant.controller不接收organizationId/role/permissions。
- [x] 权限纯策略证明Viewer不可approve；membership撤销或role改变后旧cookie即时失去对应新API权限。
- [x] HTTP测试使用fixture repository隔离网络，真实DB另由Task4端到端覆盖。
- [x] 运行auth/product/tenant回归、lint/typecheck。
- [x] Commit: feat(tenant): resolve protected contexts from current memberships

## Task 4: Bootstrap and full database/API isolation regression

Files: packages/database/src/tenant-bootstrap.ts、对应 tests、apps/api/test/tenant-database.e2e-spec.ts、
scripts/test-tenant-database.mjs、.github/workflows/ci.yml、相关package scripts与部署说明。

- [x] bootstrap默认dry run；APP_ENV只能local/test/demo且DB marker匹配；生产/未知环境拒绝。
- [x] 输入user/merchant来自显式环境/命令验证，重复执行不重复成员，已存在角色不静默升权；不改变现有membership状态。
- [x] 真实DB+Nest：Tenant A/B cookie、直接API IDOR、role降级/成员撤销、同组织未分配workspace、错误FK。
- [x] CI显式PostgreSQL隔离服务+必跑tenant测试；缺测试DB直接失败，不skip。
- [x] 旧seed/既有测试兼容性验证，现有env/生产数据库不迁移。
- [x] Commit: test(tenant): enforce database isolation and bootstrap safety gates

## Final verification and delivery

- [x] contracts/database/API测试，lint、typecheck、格式、secret scan、API build、迁移 drift。
- [x] 检查diff仅本阶段文件；独立审查tenant访问/迁移权限的关键路径。
- [x] 更新此ledger并记录实际测试数字/commit/限制，不能宣称生产identity或全commerce RLS完成。
- [x] 展示review与迁移操作说明，保留worktree供用户检查，不自动合并/部署。

下一任务是CommerceConnector契约；只有Phase1.1验收后才进入，当前不同时实现Mock或DecisionProvider。

## Execution record

工作目录：`C:/Users/harry/.codex/worktrees/tenant-foundation/aiShopASAS`；分支 `tenant-foundation`。
基线：`5e39cf6`。原 checkout 与用户未跟踪文件未修改；未复制原 `.env`，未推送/合并/部署。

| Commit  | 独立改动                                                       |
| ------- | -------------------------------------------------------------- |
| 3c400f8 | 获批 Phase 1.1 实施计划                                        |
| e20c147 | Tenant contracts / permission policy                           |
| bce6b01 | schema、legacy mapping、复合 FK、RLS 与 repository             |
| 1f37633 | 新 Tenant API、guard、service 与 HTTP 回归                     |
| 436dad6 | 默认 dry-run 的独立演示 membership bootstrap                   |
| e0ad5d2 | 角色和资源在同一 statement snapshot 判定                       |
| 61dbb5a | 普通 DB role 下的 Store 写入兼容、复合映射 FK、迁移 drift 修正 |
| 744fb7f | 精简 bootstrap transaction，遵循函数长度限制                   |
| 626d6c7 | 必跑真实 PostgreSQL/Nest API restricted-role 回归              |
| 899f29a | CI 必跑 PostgreSQL 租户门禁                                    |
| 5860d5a | 空库 migrate deploy、坏旧关联升级原子停止                      |
| 2668b42 | 实际旧 Prisma seed / order-seed 兼容回归                       |
| 12fce74 | 最大 Merchant ID 的派生租户标识长度修正                        |

TDD 红灯分别验证：缺 Tenant schema/policy 模块、缺 RLS migration、缺 repository、新 Tenant API 模块缺失、
bootstrap 模块缺失、普通 role 的 legacy Store 写入 23502、128 字符 Merchant 的派生 ID 超限。
对应绿灯已运行并通过。先前默认 pg_ctl pipe 在 Windows 导致测试启动等待，已改用独立日志和可靠的临时实例生命周期清理。

只读独立审查发现并复现两个 Important 问题（分次查询造成角色与 scope 不一致、RLS 破坏旧 Store 写入）及 migration drift；
均通过独立提交修复并复核。权限不会从 Cookie 中派生；bootstrap 与应用连接分离，且保留已有 role/status。

追加提交 `b1c7414 fix(database): separate hashed and readable legacy ID namespaces`：最终审查复现第三项 Important，
长 Merchant ID 与其 digest 作为短 Merchant ID 时原先会派生相同标识。现使用互不重叠的前缀；既有长度测试增加该 ID pair，
确认 23505 红灯与完整 25 项绿灯。独立审查已复核关闭，最终无剩余 Important。

实际验证：根 Node 23、contracts 236、database 离线 37、API 428、Web 288、独立 PostgreSQL/API 25 项通过，
总计 1,037；9 项既有 API opt-in 测试未启用。新增租户门禁无 skip。空库部署、升级、实际旧 seed、非 BYPASSRLS
角色、pool scope 清理、Prisma 空差异均通过。缺 PostgreSQL、远程 DB、URL host override 三个失败门禁返回非零。
全仓 lint/typecheck/build/format/secret scan 通过。

追加提交 `a350ba9 ci(tenant): check database and test configuration formatting`，将本阶段 database 源码/测试及 Vitest
配置的格式检查纳入 CI，避免只依赖原有 formatter 范围。

资源清理例外：两个最初启动等待时留下、已停止的临时目录 `shopmate-tenant-pg-YtgsI8`、`shopmate-tenant-pg-EJWcZE`
被自动审批拒绝递归清理（返回 `blocked by policy`），因此保留；没有绕过该拒绝。后续 runner 创建的临时实例正常关闭和清理。

完整 12 项交付报告、手动验证与 operator migration/权限步骤见
[Phase 1.1 delivery](2026-10-03-phase1-tenant-delivery.md)。RLS 只覆盖新 tenant 四表；旧 commerce 隔离、生产身份与真实数据发布门槛仍待后续阶段。
