# Phase 12 — Product Listing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans for one explicitly assigned card. Human ownership and all [global constraints](../2026-10-04-p3-p13-agile-task-pool.md) apply.

**Goal:** 交付本阶段卡片列出的、独立可验证的产品能力。

**Architecture:** 按契约并行实现组件，依赖门槛满足后真实接线；不把夹具当作生产完成。

**Tech Stack:** TypeScript / Zod / NestJS / React / Prisma / PostgreSQL / Vitest / Playwright。

<a id="p12-001"></a>

## P12-001：定义导入、草稿、校验与发布快照契约

**工时：** 3h（实现 + 定向验证 + PR 准备） · **轨道：** contract · **类型：** contract · **优先级：** P0

**契约：** ListingImportV1 / ListingDraftV1 / ListingValidationV1 / ListingPublishProposal / PublishedRefResolver

**输入：**

- 现有ListingInput/CreateProductCommand/VerifyActionQuery PRODUCT
- J2人工审批revision/hash及K商品内容安全边界

**输出：**

- UTF8 CSV imports bounded schema、draft revision/source provenance、validation errors字段路径
- immutable publish snapshot及内部Mock execution→externalProductId resolver端口；包含全部SKU/currency/正文/类目

**独占文件（新路径为计划创建）：**

- `packages/contracts/src/listings/listing.schema.ts`
- `packages/contracts/src/listings/listing.schema.spec.ts`

**共享文件锁（协调集成修改）：**

- `packages/contracts/src/index.ts`

**硬依赖：** 无

**实际接线依赖：** 无

**验收：**

- [ ] 未知权限/approvedBy/执行字段拒绝；重复sellerSkuCode拒绝
- [ ] draft/publication snapshot revision/hash/TTL与tenant/store/currency完整
- [ ] 无法解析的externalProductId不编造；validation失败不能产生可审批快照

**测试：**

- pnpm --filter @shopmate/contracts exec vitest run src/listings/listing.schema.spec.ts

**不包含：**

- 真实平台发布/LLM网络调用/部署线上迁移
- 消费者PII导入、公开上传目录或任意URL抓取
- AI审批发布、自动重试未知publish或未经审批覆盖商品

**风险：** 草稿编辑后仍使用旧发布批准

**并行分组：** `p12-listing.schema`

**执行边界：** 拟新增路径独占；fixture合成且仅测试，命名端口支持组件并行，runtime integration按依赖接线；1–4小时含定向验证/PR，每卡独立commit/PR、最新CI+审查合并才Done。契约exports锁；图片/表格复杂格式不在本次首期CSV范围。 所有函数/回调/SQL体<40行、TypeScript无any；金额/时间不默认为0/now，用户文本严格校验并sanitize；密钥仅env。

<a id="p12-002"></a>

## P12-002：实现受限上传与私有重命名存储

**工时：** 3h（实现 + 定向验证 + PR 准备） · **轨道：** backend · **类型：** component · **优先级：** P0

**契约：** ListingUploadPort / PrivateImportStorage

**输入：**

- authenticated tenant/store上传context与bounded stream
- server配置允许UTF8 CSV、上限2MiB、随机objectName及私有storage root

**输出：**

- 扩展名+MIME+实际UTF8/CSV内容校验、大小流式上限
- org/store私有namespace、随机重命名、无公开URL及安全cleanup

**独占文件（新路径为计划创建）：**

- `apps/api/src/listings/import-storage.ts`
- `apps/api/src/listings/import-storage.spec.ts`

**共享文件锁（协调集成修改）：**

- 无

**硬依赖：** P12-001

**实际接线依赖：** 无

**验收：**

- [ ] 合法CSV保存随机名并保持scope引用
- [ ] 双扩展名/伪MIME/二进制/超2MiB/path traversal拒绝并清理partial
- [ ] 其他tenant不可读对象；original filename只作sanitized metadata且无raw路径输出

**测试：**

- pnpm --filter @shopmate/api exec vitest run src/listings/import-storage.spec.ts --maxWorkers 1

**不包含：**

- 真实平台发布/LLM网络调用/部署线上迁移
- 消费者PII导入、公开上传目录或任意URL抓取
- AI审批发布、自动重试未知publish或未经审批覆盖商品

**风险：** 上传内容与目录穿越

**并行分组：** `p12-import-storage`

**执行边界：** 拟新增路径独占；fixture合成且仅测试，命名端口支持组件并行，runtime integration按依赖接线；1–4小时含定向验证/PR，每卡独立commit/PR、最新CI+审查合并才Done。只私有本地storage adapter，root/密钥来自配置环境；对象path resolver验证绝对路径在配置root内。 所有函数/回调/SQL体<40行、TypeScript无any；金额/时间不默认为0/now，用户文本严格校验并sanitize；密钥仅env。

<a id="p12-003"></a>

## P12-003：实现有界CSV解析和字段规范化

**工时：** 3h（实现 + 定向验证 + PR 准备） · **轨道：** backend · **类型：** component · **优先级：** P1

**契约：** ListingCsvParser

**输入：**

- PrivateImportStorage已校验UTF8 bytes；固定title/category/brand/sellerSkuCode/attributes/price columns
- 整数CNY分/受限十进制解析不使用浮点近似；最多500 SKU/固定行列长度

**输出：**

- row-addressed draft candidates或结构化validation errors
- 拒绝多余/重复headers、control chars、unsafe金额与重复SKU

**独占文件（新路径为计划创建）：**

- `apps/api/src/listings/listing-csv-parser.ts`
- `apps/api/src/listings/listing-csv-parser.spec.ts`

**共享文件锁（协调集成修改）：**

- 无

**硬依赖：** P12-001

**实际接线依赖：** 无

**验收：**

- [ ] 带合法引号/换行CSV映射同一ListingInput且金额精确
- [ ] 坏header/未闭合quote/超限行列/duplicate SKU返回具体row/field
- [ ] 公式前缀=+@/-及商品文本仅不可信text，无代码执行/URL读取

**测试：**

- pnpm --filter @shopmate/api exec vitest run src/listings/listing-csv-parser.spec.ts --maxWorkers 1

**不包含：**

- 真实平台发布/LLM网络调用/部署线上迁移
- 消费者PII导入、公开上传目录或任意URL抓取
- AI审批发布、自动重试未知publish或未经审批覆盖商品

**风险：** CSV注入和无限解析资源

**并行分组：** `p12-listing-csv-parser`

**执行边界：** 拟新增路径独占；fixture合成且仅测试，命名端口支持组件并行，runtime integration按依赖接线；1–4小时含定向验证/PR，每卡独立commit/PR、最新CI+审查合并才Done。 所有函数/回调/SQL体<40行、TypeScript无any；金额/时间不默认为0/now，用户文本严格校验并sanitize；密钥仅env。

<a id="p12-004"></a>

## P12-004：新增导入、草稿和校验结果表

**工时：** 3h（实现 + 定向验证 + PR 准备） · **轨道：** database · **类型：** integration · **优先级：** P1

**契约：** ListingDraftPersistenceV1

**输入：**

- 现有tenant/store FK/RLS、私有对象metadata reference
- draft revision及immutable validation snapshot、external mapping scope

**输出：**

- ListingImport/ListingDraft/ListingValidationError增量模型migration
- 私有objectKey归属、revision唯一、引用及查询索引

**独占文件（新路径为计划创建）：**

- `packages/database/src/listings/listing-model.ts`
- `packages/database/test/listings/listing-model.test.mjs`

**共享文件锁（协调集成修改）：**

- `packages/database/prisma/schema.prisma`
- `packages/database/prisma/migrations/20261005120100_listing_drafts/migration.sql`

**硬依赖：** P12-001

**实际接线依赖：** 无

**验收：**

- [ ] 跨tenant/store import→draft关联拒绝策略明确
- [ ] object reference不存公共URL/凭证；正文有bounded长度
- [ ] 空库/升级migration contract验证并定义缺scope RLS拒绝

**测试：**

- pnpm --filter @shopmate/database exec node --import tsx --test test/listings/listing-model.test.mjs
- pnpm --filter @shopmate/database prisma:validate

**不包含：**

- 真实平台发布/LLM网络调用/部署线上迁移
- 消费者PII导入、公开上传目录或任意URL抓取
- AI审批发布、自动重试未知publish或未经审批覆盖商品

**风险：** 私有对象与草稿ownership漂移

**并行分组：** `p12-listing-model`

**执行边界：** 拟新增路径独占；fixture合成且仅测试，命名端口支持组件并行，runtime integration按依赖接线；1–4小时含定向验证/PR，每卡独立commit/PR、最新CI+审查合并才Done。 所有函数/回调/SQL体<40行、TypeScript无any；金额/时间不默认为0/now，用户文本严格校验并sanitize；密钥仅env。

<a id="p12-005"></a>

## P12-005：实现草稿修订与审计事务仓库

**工时：** 3h（实现 + 定向验证 + PR 准备） · **轨道：** backend · **类型：** integration · **优先级：** P1

**契约：** ListingDraftRepository

**输入：**

- tenant transaction、ListingDraftPersistenceV1、expectedRevision
- P09-004 mutation audit；import object metadata验证已属当前scope

**输出：**

- 导入登记/create/read/edit/validation append仓库
- 编辑新revision使旧validation/publish快照不可使用

**独占文件（新路径为计划创建）：**

- `apps/api/src/listings/listing-draft.repository.ts`
- `apps/api/src/listings/listing-draft.repository.spec.ts`

**共享文件锁（协调集成修改）：**

- 无

**硬依赖：** P12-004, P09-004

**实际接线依赖：** 无

**验收：**

- [ ] 合法草稿保留source provenance和当前revision
- [ ] 并发edit仅一个成功；跨tenant/store/object ref拒绝
- [ ] audit失败回滚draft/validation mutation；旧validation不得许可新revision发布

**测试：**

- pnpm --filter @shopmate/api exec vitest run src/listings/listing-draft.repository.spec.ts --maxWorkers 1

**不包含：**

- 真实平台发布/LLM网络调用/部署线上迁移
- 消费者PII导入、公开上传目录或任意URL抓取
- AI审批发布、自动重试未知publish或未经审批覆盖商品

**风险：** 未重新校验的草稿被发布

**并行分组：** `p12-listing-draft.repository`

**执行边界：** 拟新增路径独占；fixture合成且仅测试，命名端口支持组件并行，runtime integration按依赖接线；1–4小时含定向验证/PR，每卡独立commit/PR、最新CI+审查合并才Done。 所有函数/回调/SQL体<40行、TypeScript无any；金额/时间不默认为0/now，用户文本严格校验并sanitize；密钥仅env。

<a id="p12-006"></a>

## P12-006：实现类目、禁售与夸大文案校验

**工时：** 3h（实现 + 定向验证 + PR 准备） · **轨道：** backend · **类型：** component · **优先级：** P0

**契约：** ListingValidationPolicyV1

**输入：**

- ListingInput untrusted text与版本化本地category/禁售/夸大词规则
- 未知类目/规则未覆盖必须需人工校验，不能宣称法律合规

**输出：**

- 字段路径errors/warnings、ruleVersion与人工校验状态
- 缺品牌/金额/属性schema明确阻断；商品文本不插入system policy

**独占文件（新路径为计划创建）：**

- `apps/api/src/listings/listing-validation-policy.ts`
- `apps/api/src/listings/listing-validation-policy.spec.ts`

**共享文件锁（协调集成修改）：**

- 无

**硬依赖：** P12-001

**实际接线依赖：** 无

**验收：**

- [ ] 支持类目合法内容通过结构校验并留ruleVersion
- [ ] 禁售词/夸大疗效/未知类目阻断或NEEDS_REVIEW；保留具体字段
- [ ] prompt injection/HTML/script控制字符不执行；未覆盖规则不能显示完全合规

**测试：**

- pnpm --filter @shopmate/api exec vitest run src/listings/listing-validation-policy.spec.ts --maxWorkers 1

**不包含：**

- 真实平台发布/LLM网络调用/部署线上迁移
- 消费者PII导入、公开上传目录或任意URL抓取
- AI审批发布、自动重试未知publish或未经审批覆盖商品

**风险：** 本地词表被宣传为平台合规保证

**并行分组：** `p12-listing-validation-policy`

**执行边界：** 拟新增路径独占；fixture合成且仅测试，命名端口支持组件并行，runtime integration按依赖接线；1–4小时含定向验证/PR，每卡独立commit/PR、最新CI+审查合并才Done。 所有函数/回调/SQL体<40行、TypeScript无any；金额/时间不默认为0/now，用户文本严格校验并sanitize；密钥仅env。

<a id="p12-007"></a>

## P12-007：生成保留来源的商品文案草稿

**工时：** 3h（实现 + 定向验证 + PR 准备） · **轨道：** backend · **类型：** component · **优先级：** P1

**契约：** ListingCopyDraftPort

**输入：**

- structured DATA envelope与strict provider output port；商品原文不可信
- 已有approved provider policy及本地Mock/规则摘要模式，运行budget/cancel

**输出：**

- 候选文案draft与source provenance/生成方式标签
- 生成后仍走ListingValidationPolicy及人工预览，不改批准内容

**独占文件（新路径为计划创建）：**

- `apps/api/src/listings/listing-copy-draft.ts`
- `apps/api/src/listings/listing-copy-draft.spec.ts`

**共享文件锁（协调集成修改）：**

- 无

**硬依赖：** P12-001

**实际接线依赖：** P06-001, P12-006

**验收：**

- [ ] 合法合成输入生成有界title/description并注明Mock/规则草稿
- [ ] 注入文本要求approve/取secret不进入policy；provider非法输出拒绝
- [ ] timeout/cancel/预算耗尽保留原草稿无虚构成功；无法验证功效不自动编造

**测试：**

- pnpm --filter @shopmate/api exec vitest run src/listings/listing-copy-draft.spec.ts --maxWorkers 1

**不包含：**

- 真实平台发布/LLM网络调用/部署线上迁移
- 消费者PII导入、公开上传目录或任意URL抓取
- AI审批发布、自动重试未知publish或未经审批覆盖商品

**风险：** 文案生成捏造功效/自动发布

**并行分组：** `p12-listing-copy-draft`

**执行边界：** 拟新增路径独占；fixture合成且仅测试，命名端口支持组件并行，runtime integration按依赖接线；1–4小时含定向验证/PR，每卡独立commit/PR、最新CI+审查合并才Done。 所有函数/回调/SQL体<40行、TypeScript无any；金额/时间不默认为0/now，用户文本严格校验并sanitize；密钥仅env。

<a id="p12-008"></a>

## P12-008：新增导入和草稿编辑HTTP入口

**工时：** 4h（实现 + 定向验证 + PR 准备） · **轨道：** backend · **类型：** component · **优先级：** P1

**契约：** ListingImportHttp / ListingDraftHttp

**输入：**

- TenantScopeService.resolve + strict header/path scope/current auth + route-specific strict body；不使用拒绝body/query的context-read-only guard；/current actions:propose+store products:write与read权限
- storage/parser/repository/validator注入端口，bounded multipart CSV输入

**输出：**

- 拟新增listing imports、draft read/revise/generate endpoints
- 默认认证、server-derived scope及revision/error映射

**独占文件（新路径为计划创建）：**

- `apps/api/src/listings/listing.controller.ts`
- `apps/api/src/listings/listing.controller.spec.ts`

**共享文件锁（协调集成修改）：**

- 无

**硬依赖：** P12-001

**实际接线依赖：** P12-002, P12-003, P12-005, P12-006, P12-007

**验收：**

- [ ] 匿名/Viewer写/跨tenant对象及未知body字段拒绝
- [ ] 合法CSV得到草稿+row错误，不触发发布；编辑expectedRevision CAS
- [ ] 超size/伪类型400/413且无partial对象；old revision409，生成错误不抹原稿

**测试：**

- pnpm --filter @shopmate/api exec vitest run src/listings/listing.controller.spec.ts --maxWorkers 1

**不包含：**

- 真实平台发布/LLM网络调用/部署线上迁移
- 消费者PII导入、公开上传目录或任意URL抓取
- AI审批发布、自动重试未知publish或未经审批覆盖商品

**风险：** 通过multipart绕输入白名单

**并行分组：** `p12-listing.controller`

**执行边界：** 拟新增路径独占；fixture合成且仅测试，命名端口支持组件并行，runtime integration按依赖接线；1–4小时含定向验证/PR，每卡独立commit/PR、最新CI+审查合并才Done。 所有函数/回调/SQL体<40行、TypeScript无any；金额/时间不默认为0/now，用户文本严格校验并sanitize；密钥仅env。

<a id="p12-009"></a>

## P12-009：制作导入、草稿编辑与发布预览

**工时：** 4h（实现 + 定向验证 + PR 准备） · **轨道：** frontend · **类型：** component · **优先级：** P1

**契约：** ListingDraftWorkspaceViewModel

**输入：**

- 草稿revision/field errors/provenance与注入client
- 现有表单/上传控件/Card及P7approval preview layout

**输出：**

- UTF8 CSV导入、字段编辑和完整immutable发布预览UI
- loading/empty/error、无默认发布勾选，375px支持

**独占文件（新路径为计划创建）：**

- `apps/web/src/app/listings/listing-workspace.tsx`
- `apps/web/src/app/listings/listing-workspace.test.tsx`

**共享文件锁（协调集成修改）：**

- 无

**硬依赖：** P12-001

**实际接线依赖：** P12-008, P07-012

**验收：**

- [ ] 错误定位row/field，可修正并看到新revision
- [ ] 预览全部SKU价格/类目/正文/证据来源与发布scope；渲染untrusted text无HTML执行
- [ ] 375px/桌面loading/empty/error；编辑后取消旧发布确认，删除草稿二次确认

**测试：**

- pnpm --filter @shopmate/web exec vitest run src/app/listings/listing-workspace.test.tsx

**不包含：**

- 真实平台发布/LLM网络调用/部署线上迁移
- 消费者PII导入、公开上传目录或任意URL抓取
- AI审批发布、自动重试未知publish或未经审批覆盖商品

**风险：** 用户只预览部分SKU内容

**并行分组：** `p12-listing-workspace`

**执行边界：** 拟新增路径独占；fixture合成且仅测试，命名端口支持组件并行，runtime integration按依赖接线；1–4小时含定向验证/PR，每卡独立commit/PR、最新CI+审查合并才Done。 所有函数/回调/SQL体<40行、TypeScript无any；金额/时间不默认为0/now，用户文本严格校验并sanitize；密钥仅env。

<a id="p12-010"></a>

## P12-010：映射草稿到独立人工发布提案

**工时：** 3h（实现 + 定向验证 + PR 准备） · **轨道：** backend · **类型：** component · **优先级：** P0

**契约：** ListingPublishProposalBuilder

**输入：**

- 当前已校验draft revision+content hash+validation rule version
- P7通用审批绑定、listing capability与P12完整snapshot；不复用price低风险

**输出：**

- 新的PRODUCT_PUBLISH候选与确定性listing risk/scope核验
- 草稿/全部SKU文本价格进入hash；人工approve后才能生成CreateProductCommand

**独占文件（新路径为计划创建）：**

- `apps/api/src/listings/listing-publish-proposal.ts`
- `apps/api/src/listings/listing-publish-proposal.spec.ts`

**共享文件锁（协调集成修改）：**

- 无

**硬依赖：** P12-001

**实际接线依赖：** P12-005, P12-006, P07-002, P07-003, P07-008

**验收：**

- [ ] 同draft可建立待审批完整snapshot，绝不写source
- [ ] 编辑任一文字/SKU/金额/类目变revision/hash，旧approval失效
- [ ] publishProduct unsupported、无当前权限/critical或未知校验状态拒绝

**测试：**

- pnpm --filter @shopmate/api exec vitest run src/listings/listing-publish-proposal.spec.ts --maxWorkers 1

**不包含：**

- 真实平台发布/LLM网络调用/部署线上迁移
- 消费者PII导入、公开上传目录或任意URL抓取
- AI审批发布、自动重试未知publish或未经审批覆盖商品

**风险：** 价格风险策略套商品发布导致低估

**并行分组：** `p12-listing-publish-proposal`

**执行边界：** 拟新增路径独占；fixture合成且仅测试，命名端口支持组件并行，runtime integration按依赖接线；1–4小时含定向验证/PR，每卡独立commit/PR、最新CI+审查合并才Done。 所有函数/回调/SQL体<40行、TypeScript无any；金额/时间不默认为0/now，用户文本严格校验并sanitize；密钥仅env。

<a id="p12-011"></a>

## P12-011：实现Mock新商品发布源事务

**工时：** 4h（实现 + 定向验证 + PR 准备） · **轨道：** database · **类型：** integration · **优先级：** P0

**契约：** MockListingCommandStore / PublishedRefResolver

**输入：**

- 现有Mock source/control transaction与受限source身份、command receipt/pending visibility
- CreateProductCommand strict listing；stable execution key/hash

**输出：**

- source生成新product/SKU映射并同事务持久command receipt/ref/visibility
- 内部executionId→externalProductId可信resolver；合法重复返回原result

**独占文件（新路径为计划创建）：**

- `packages/database/src/mock-actions/create-listing.ts`
- `packages/database/test/integration/mock-listing-write.test.mjs`

**共享文件锁（协调集成修改）：**

- `scripts/test-tenant-database.mjs`

**硬依赖：** P12-001, P08-016, P2-GATE

**实际接线依赖：** 无

**验收：**

- [ ] 同key/hash只新建一个product及SKU集，resolver返回实际关联id
- [ ] 同key不同listing、跨tenant/generation、重复SKU拒绝并整体回滚
- [ ] publish和reset/disconnect锁后重查，丢包保留实际源结果；不写规范经营DB

**测试：**

- pnpm test:tenant

**不包含：**

- 真实平台发布/LLM网络调用/部署线上迁移
- 消费者PII导入、公开上传目录或任意URL抓取
- AI审批发布、自动重试未知publish或未经审批覆盖商品

**风险：** 新建商品回执没有externalProductId

**并行分组：** `p12-create-listing`

**执行边界：** 拟新增文件独占；复用P08-016 typed externalResourceRef列与P2受限source/control事务，不读取scenario oracle。4小时含验证/PR；独立commit、最新CI/审查并合并才Done。只source新建+实际ref关联，不改通用schema，不执行规范库同步。 所有函数/回调/SQL体<40行、TypeScript无any；金额/时间不默认为0/now，用户文本严格校验并sanitize；密钥仅env。

<a id="p12-012"></a>

## P12-012：接入Mock发布和独立商品回读

**工时：** 3h（实现 + 定向验证 + PR 准备） · **轨道：** integration · **类型：** integration · **优先级：** P0

**契约：** MockListingActionAdapter / PublishedRefResolver / PRODUCT verification

**输入：**

- trusted MockPublishedRefResolver及source商品读/visibility端口
- 原ListingInput snapshot/hash、CommerceConnector.createProduct/verifyAction PRODUCT

**输出：**

- Mock发布adapter及publish capability、PRODUCT原始回读
- 缺ref或read失败返回PENDING/UNKNOWN，不猜external id

**独占文件（新路径为计划创建）：**

- `apps/api/src/integrations/mock/mock-listing-actions.ts`
- `apps/api/src/integrations/mock/mock-listing-actions.spec.ts`

**共享文件锁（协调集成修改）：**

- `apps/api/src/integrations/mock/mock-commerce-connector.ts`
- `apps/api/src/integrations/mock/mock-connector-factory.ts`

**硬依赖：** P12-011, P08-007, P08-018

**实际接线依赖：** 无

**验收：**

- [ ] 新商品独立readback完整listing匹配才VERIFIED
- [ ] 丢包可由可信ref恢复，不再次create；未可见PENDING
- [ ] ref scope/execution/generation错或SKU/价格/正文mismatch拒绝/冲突；不读规范DB伪证据

**测试：**

- pnpm --filter @shopmate/api exec vitest run src/integrations/mock/mock-listing-actions.spec.ts --maxWorkers 1

**不包含：**

- 真实平台发布/LLM网络调用/部署线上迁移
- 消费者PII导入、公开上传目录或任意URL抓取
- AI审批发布、自动重试未知publish或未经审批覆盖商品

**风险：** 未知create重复导致重复商品

**并行分组：** `p12-mock-listing-actions`

**执行边界：** 拟新增路径独占；fixture合成且仅测试，命名端口支持组件并行，runtime integration按依赖接线；1–4小时含定向验证/PR，每卡独立commit/PR、最新CI+审查合并才Done。继P08-018后持同mock-connector wiring锁，只添加PRODUCT分支。 所有函数/回调/SQL体<40行、TypeScript无any；金额/时间不默认为0/now，用户文本严格校验并sanitize；密钥仅env。

<a id="p12-013"></a>

## P12-013：接入商品工作区、发布审批和worker

**工时：** 3h（实现 + 定向验证 + PR 准备） · **轨道：** integration · **类型：** integration · **优先级：** P1

**契约：** ListingsModuleWiring / PublishExecutionStrategy

**输入：**

- 已有P7 human approval/real TTL与P8 execution/outbox/lease/readback
- published ref resolver、完整listing snapshot，current权限/connection generation guard

**输出：**

- listing routes、审批与已有execution strategy接桥
- PRODUCT_PUBLISH只人批准后排入outbox，未verified仍EXECUTING

**独占文件（新路径为计划创建）：**

- `apps/api/src/listings/listings.module.ts`
- `apps/api/src/listings/listings.module.spec.ts`

**共享文件锁（协调集成修改）：**

- `apps/api/src/app.module.ts`
- `packages/contracts/src/index.ts`
- `apps/web/src/app/page.tsx`
- `packages/contracts/src/actions/proposal.schema.ts`
- `apps/api/src/actions/execution.module.ts`

**硬依赖：** P12-005, P12-006, P12-007, P12-008, P12-009, P12-010, P12-012, P07-014, P08-013, P09-004, P10-003, P2-GATE

**实际接线依赖：** 无

**验收：**

- [ ] 真实component连线后import→draft→preview→human approval→一次create可调用
- [ ] draft revision/hash变化、revoked权限/expired TTL执行前阻断
- [ ] publish receipt ACCEPTED/UNKNOWN不会SUCCEEDED；无AI approve/execute工具

**测试：**

- pnpm --filter @shopmate/api exec vitest run src/listings/listings.module.spec.ts --maxWorkers 1

**不包含：**

- 真实平台发布/LLM网络调用/部署线上迁移
- 消费者PII导入、公开上传目录或任意URL抓取
- AI审批发布、自动重试未知publish或未经审批覆盖商品

**风险：** 跨领域union注册被误认为默认允许

**并行分组：** `p12-listings.module`

**执行边界：** 拟新增路径独占；fixture合成且仅测试，命名端口支持组件并行，runtime integration按依赖接线；1–4小时含定向验证/PR，每卡独立commit/PR、最新CI+审查合并才Done。分别持聚合协调锁；P7 action schema listing扩展只在P07-014之后且独立commit，动作policy仍deny-by-default；不重写executor。 所有函数/回调/SQL体<40行、TypeScript无any；金额/时间不默认为0/now，用户文本严格校验并sanitize；密钥仅env。

<a id="p12-014"></a>

## P12-014：证明上传私有归属与草稿数据库隔离

**工时：** 4h（实现 + 定向验证 + PR 准备） · **轨道：** qa · **类型：** verification · **优先级：** P0

**契约：** ListingImportIsolationProof

**输入：**

- isolated-postgres受限app身份、私有临时storage root
- 两组织HTTP multipart与恶意上传fixtures

**输出：**

- RLS/FK、object归属、draft CAS及audit rollback证明
- 空库/升级migration必跑suite与upload cleanup断言

**独占文件（新路径为计划创建）：**

- `packages/database/test/integration/listing-import.test.mjs`

**共享文件锁（协调集成修改）：**

- `scripts/test-tenant-database.mjs`

**硬依赖：** P12-002, P12-004, P12-005, P12-008, P09-004

**实际接线依赖：** 无

**验收：**

- [ ] 跨tenant/store import-draft FK与private-object读取拒绝
- [ ] 超限/伪类型/path traversal拒绝且临时root外无写入
- [ ] 并发revision仅一有效；audit异常草稿与登记回滚，orphan对象清理有据

**测试：**

- pnpm test:tenant

**不包含：**

- 真实平台发布/LLM网络调用/部署线上迁移
- 消费者PII导入、公开上传目录或任意URL抓取
- AI审批发布、自动重试未知publish或未经审批覆盖商品

**风险：** DB拒绝后私有对象残留

**并行分组：** `p12-listing-import`

**执行边界：** 拟新增路径独占；fixture合成且仅测试，命名端口支持组件并行，runtime integration按依赖接线；1–4小时含定向验证/PR，每卡独立commit/PR、最新CI+审查合并才Done。 所有函数/回调/SQL体<40行、TypeScript无any；金额/时间不默认为0/now，用户文本严格校验并sanitize；密钥仅env。

<a id="p12-015"></a>

## P12-015：验证完整Mock发布与未知结果恢复

**工时：** 4h（实现 + 定向验证 + PR 准备） · **轨道：** qa · **类型：** verification · **优先级：** P0

**契约：** ListingPublishReadbackProof

**输入：**

- 本地isolated DB/HTTP真实human批准与Mock source失败规则
- 同draft/hash→approval→execution→publishedRef→independent source readback

**输出：**

- import/draft/preview/approve/publish/verify真实集成链证明
- 同key一次create与完整audit关联；同步后规范库才见新listing

**独占文件（新路径为计划创建）：**

- `apps/api/test/listing-publish.e2e-spec.ts`

**共享文件锁（协调集成修改）：**

- 无

**硬依赖：** P12-013, P12-014, P07-019, P08-014, P2-GATE

**实际接线依赖：** 无

**验收：**

- [ ] 合法草稿完整预览+人工批准后只create一次，readback匹配才成功
- [ ] timeout-after-create/restart/延迟可见保留UNKNOWN/PENDING，无二次create
- [ ] 编辑/过期/撤销/connection generation漂移阻断，B租户无对象/审批可见

**测试：**

- pnpm --filter @shopmate/api exec vitest run test/listing-publish.e2e-spec.ts --maxWorkers 1

**不包含：**

- 真实平台发布/LLM网络调用/部署线上迁移
- 消费者PII导入、公开上传目录或任意URL抓取
- AI审批发布、自动重试未知publish或未经审批覆盖商品

**风险：** 回读成功前规范库提前伪造发布

**并行分组：** `p12-listing-publish.e2e`

**执行边界：** 拟新增路径独占；fixture合成且仅测试，命名端口支持组件并行，runtime integration按依赖接线；1–4小时含定向验证/PR，每卡独立commit/PR、最新CI+审查合并才Done。 所有函数/回调/SQL体<40行、TypeScript无any；金额/时间不默认为0/now，用户文本严格校验并sanitize；密钥仅env。
