# Phase 1.1 Tenant Foundation Implementation Plan

状态：执行中；产品负责人已批准 2026-10-03 架构审查及 Phase 1.1。

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

- [ ] 先写 schema/权限测试；覆盖 unknown arguments、非法/超长ID、重复permission、同组织/同工作区访问、跨组织、Viewer拒批、Operator默认拒批。
- [ ] 红灯命令：pnpm --filter @shopmate/contracts exec vitest run src/tenant
- [ ] 实现 strict schema 与纯 policy：

```ts
canAccessTenantResource(context, resource, permission)
// 必须同时满足：
// context.organizationId === resource.organizationId
// resource.workspaceId 缺省或等于 context.workspaceId
// context.permissions 包含 permission
```

- [ ] 绿灯、contracts lint/typecheck/test。
- [ ] Commit: feat(contracts): define tenant scope and resource permissions

## Task 2: Additive schema, legacy mapping and relation integrity

Files: packages/database/prisma/schema.prisma、新 migration、test/tenant-database.test.mjs、test/helpers/isolated-postgres.mjs、
src/tenant-membership.ts、src/index.ts、package.json。

Produces: Organization、OrganizationMember、Workspace、WorkspaceMember；
Organization.legacyMerchantId 唯一 FK 指向 Merchant；Store 可关联 Workspace；
OrderItem.merchantId 自动继承 Order；Sku→Product 和 OrderItem→Order/Sku 复合 merchant FK。

- [ ] 写真实 PostgreSQL 升级/空库测试，在旧迁移后插入两商家商品/订单再应用新 migration：

```js
await assert.rejects(
  client.query('INSERT INTO "Sku" (...) VALUES ($1, $2, $3, ...)', crossMerchantValues),
  (error) => error.code === '23503',
);
```

- [ ] 红灯：新表查询失败 / 未有复合约束时错误关联成功。
- [ ] 新 migration 回填每 Merchant 对应 legacy organization + default Workspace，不推断任何 user membership。
- [ ] 迁移必须检查已有坏关联并事务失败，不静默修正租户。
- [ ] AFTER INSERT Merchant trigger 维护旧seed新增商家的 legacy mapping；OrderItem BEFORE trigger 继承/校验 merchant。
- [ ] 独立 Prisma repository 函数 resolveTenantMembership(userId, merchantId, workspaceId?) 用身份 scope transaction，参数化 set_config；
  返回 membership/角色/workspace，经域服务建立context。
- [ ] PostgreSQL新表SELECT RLS：app.user_id + ACTIVE membership、OWNER/ADMIN或WorkspaceMember；缺身份读空；
  普通app不写tenant membership；migration owner/bootstrap操作员分离。
- [ ] 覆盖 inactive成员/组织/工作区、外组织workspace、未分配同组织workspace、missing scope、连接池事务清理。
- [ ] prisma validate/generate/build；新迁移增量验证；数据库 tests。
- [ ] Commit: feat(database): add tenant foundation and legacy ownership constraints

## Task 3: Resolve memberships and expose protected tenant API

Files: apps/api/src/tenant/{tenant.module,tenant.controller,tenant-context.guard,tenant-context.decorator,
tenant-scope.service,tenant-membership.repository}.ts、对应 specs 与 test/tenant-context.e2e-spec.ts、app.module.ts。

Consumes: Task1 schemas/policy、Task2 resolveTenantMembership。
Produces: GET /api/v1/tenant/context、GET /api/v1/tenant/workspaces/:workspaceId。
默认workspace为legacy default；X-Workspace-Id可选，须严格验证并校验当前身份授权。

- [ ] 单元与HTTP红灯测试：未登录401；缺member/跨组织/未分配workspace404；
  header重复/非法/与path不一致400；body/query tenant覆盖404；DB异常503无详情。
- [ ] TenantGuard读取全局MerchantGuard已验证userId/merchantId，忽略cookie permission。
- [ ] TenantScopeService调用repository，输出冻结TenantContext；tenant.controller不接收organizationId/role/permissions。
- [ ] 权限纯策略证明Viewer不可approve；membership撤销或role改变后旧cookie即时失去对应新API权限。
- [ ] HTTP测试使用fixture repository隔离网络，真实DB另由Task4端到端覆盖。
- [ ] 运行auth/product/tenant回归、lint/typecheck。
- [ ] Commit: feat(tenant): resolve protected contexts from current memberships

## Task 4: Bootstrap and full database/API isolation regression

Files: packages/database/src/tenant-bootstrap.ts、对应 tests、apps/api/test/tenant-database.e2e-spec.ts、
scripts/test-tenant-database.mjs、.github/workflows/ci.yml、相关package scripts与部署说明。

- [ ] bootstrap默认dry run；APP_ENV只能local/test/demo且DB marker匹配；生产/未知环境拒绝。
- [ ] 输入user/merchant来自显式环境/命令验证，重复执行不重复成员，已存在角色不静默升权；不改变现有membership状态。
- [ ] 真实DB+Nest：Tenant A/B cookie、直接API IDOR、role降级/成员撤销、同组织未分配workspace、错误FK。
- [ ] CI显式PostgreSQL隔离服务+必跑tenant测试；缺测试DB直接失败，不skip。
- [ ] 旧seed/既有测试兼容性验证，现有env/生产数据库不迁移。
- [ ] Commit: test(tenant): enforce database isolation and bootstrap safety gates

## Final verification and delivery

- [ ] contracts/database/API测试，lint、typecheck、格式、secret scan、API build、迁移 drift。
- [ ] 检查diff仅本阶段文件；独立审查tenant访问/迁移权限的关键路径。
- [ ] 更新此ledger并记录实际测试数字/commit/限制，不能宣称生产identity或全commerce RLS完成。
- [ ] 展示review与迁移操作说明，保留worktree供用户检查，不自动合并/部署。

下一任务是CommerceConnector契约；只有Phase1.1验收后才进入，当前不同时实现Mock或DecisionProvider。
