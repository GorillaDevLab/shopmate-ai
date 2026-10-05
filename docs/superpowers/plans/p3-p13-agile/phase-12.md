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

**契约：** DeterministicLocalListingCopyPort / LocalRulesVersion

**输入：**

- P12-001 strict listing fields/provenance；sanitize不可信原文，不解析指令
- 版本化自包含本地规则：仅已提供属性拼接有界title/description，不调用Agent/provider/LLM；AbortSignal+行数/字数上限

**输出：**

- 可复算local-rules draft、ruleVersion与每字段source refs；无法验证属性保留原文/缺失
- 输出仍由P12-006校验并人工预览，编辑生成均不批准/发布

**独占文件（新路径为计划创建）：**

- `apps/api/src/listings/listing-copy-draft.ts`
- `apps/api/src/listings/listing-copy-draft.spec.ts`

**共享文件锁（协调集成修改）：**

- 无

**硬依赖：** P12-001

**实际接线依赖：** P12-006

**验收：**

- [ ] 相同输入/ruleVersion输出稳定，字段长度有界且标LOCAL_RULES；无虚构功效/来源
- [ ] 注入要求approve/secret仅当sanitized DATA，无工具/网络调用且无假LLM标签
- [ ] cancel/超字符或行数上限返回错误保留原draft，validator拒绝则不提交新revision

**测试：**

- pnpm --filter @shopmate/api exec vitest run src/listings/listing-copy-draft.spec.ts --maxWorkers 1

**不包含：**

- 真实平台发布/LLM网络调用/部署线上迁移
- 消费者PII导入、公开上传目录或任意URL抓取
- AI审批发布、自动重试未知publish或未经审批覆盖商品
- Agent/LLM gateway接入、provider budget policy与生成模型调用；本卡选择自包含deterministic local rules

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
- P12-016完整typed发布提案、P12-017发布专属hash/risk、P7通用审批绑定；绝不复用price风险

**输出：**

- 新的PRODUCT_PUBLISH候选与确定性listing risk/scope核验
- 草稿/全部SKU文本价格进入hash；人工approve后才能生成CreateProductCommand

**独占文件（新路径为计划创建）：**

- `apps/api/src/listings/listing-publish-proposal.ts`
- `apps/api/src/listings/listing-publish-proposal.spec.ts`

**共享文件锁（协调集成修改）：**

- 无

**硬依赖：** P12-001, P12-016

**实际接线依赖：** P12-005, P12-006, P12-017, P07-007, P07-008

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

- P08-036公共SourceCommandRequestStore/P08-038独立request-pinned readback，P08-039同clock真实发布proof；P2-GATE只提供immutable read publication基础，不假设提供writers
- CreateProductCommand strict listing；stable execution key/hash

**输出：**

- append typed create-product request，同tx durable receipt/requestRevision/可信product+SKU ref；P08-037在新published source中可见，不直接写immutable旧行
- 内部executionId→externalProductId可信resolver；合法重复返回原result
- 在同PR经database-index共享锁从现有@shopmate/database root发布typed store/resolver公共导出；不新增未拥有的subpath
- 本卡持runner/config共享锁显式注册必跑目标：packages/database/test/integration/mock-listing-write.test.mjs；API目标tenant config include且default config exclude，DB nested目标由runner显式调用，不依赖test/\*.test.mjs

**独占文件（新路径为计划创建）：**

- `packages/database/src/mock-actions/create-listing.ts`
- `packages/database/test/integration/mock-listing-write.test.mjs`

**共享文件锁（协调集成修改）：**

- `scripts/test-tenant-database.mjs`
- `packages/database/src/index.ts`

**硬依赖：** P12-001, P08-016, P2-GATE, P08-036, P08-038, P08-039

**实际接线依赖：** 无

**验收：**

- [ ] 同key/hash只新建一个product及SKU集，resolver返回实际关联id
- [ ] 同key不同listing、跨tenant/generation、重复SKU拒绝并整体回滚
- [ ] publish和reset/disconnect锁后重查，丢包保留实际源结果；不写规范经营DB
- [ ] consumer只从@shopmate/database root import；数据库build和API typecheck验证公共类型，禁止私有src路径import
- [ ] pnpm test:tenant仅用isolatedPostgres新建/stop disposable数据库及runner生成TEST_DATABASE_URL/runtime DATABASE_URL；清除继承开发DATABASE_URL，目标集非空且每个注册目标执行>0、0 skipped，零选择或skip失败

**测试：**

- pnpm --filter @shopmate/database build
- pnpm --filter @shopmate/api typecheck
- pnpm test:tenant

**不包含：**

- 真实平台发布/LLM网络调用/部署线上迁移
- 消费者PII导入、公开上传目录或任意URL抓取
- AI审批发布、自动重试未知publish或未经审批覆盖商品

**风险：** 新建商品回执没有externalProductId

**并行分组：** `p12-create-listing`

**执行边界：** 拟新增文件独占；复用P08-016 typed externalResourceRef列与P2受限source/control事务，不读取scenario oracle。4小时含验证/PR；独立commit、最新CI/审查并合并才Done。只source新建+实际ref关联，不改通用schema，不执行规范库同步。 所有函数/回调/SQL体<40行、TypeScript无any；金额/时间不默认为0/now，用户文本严格校验并sanitize；密钥仅env。 必跑目标注册属于本卡，不留给未来runner任务；测试database helper只用runner URL，不允许直跑套用开发DATABASE_URL。 源命令前置P08-033..039覆盖requestRevision/receipt-backed same-tick chronology/固定prefix/publication/readback；本卡仅单动作映射+request事务，不实现通用source publication扩展。

<a id="p12-012"></a>

## P12-012：接入Mock发布和独立商品回读

**工时：** 3h（实现 + 定向验证 + PR 准备） · **轨道：** integration · **类型：** integration · **优先级：** P0

**契约：** MockListingActionAdapter / PublishedRefResolver / PRODUCT verification

**输入：**

- trusted MockPublishedRefResolver及source商品读/visibility端口
- 原ListingInput snapshot/hash、CommerceConnector.createProduct/verifyAction PRODUCT
- store/resolver通过已合并@shopmate/database root公共导出；当前package只有root与mock-platform，不使用mock-actions私有路径
- P08-038 public CommandPublicationReadPort以certificate.requestRevision>=command receipt gate独立source read；publication前PENDING，currentMock其余writes显式UNSUPPORTED

**输出：**

- Mock发布adapter及publish capability、PRODUCT原始回读
- 缺ref或read失败返回PENDING/UNKNOWN，不猜external id

**独占文件（新路径为计划创建）：**

- `apps/api/src/integrations/mock/mock-listing-actions.ts`
- `apps/api/src/integrations/mock/mock-listing-actions.spec.ts`

**共享文件锁（协调集成修改）：**

- `apps/api/src/integrations/mock/mock-commerce-connector.ts`
- `apps/api/src/integrations/mock/mock-connector-factory.ts`

**硬依赖：** P12-011, P08-007, P08-018, P08-038, P08-039

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

**执行边界：** 拟新增路径独占；fixture合成且仅测试，命名端口支持组件并行，runtime integration按依赖接线；1–4小时含定向验证/PR，每卡独立commit/PR、最新CI+审查合并才Done。继P08-018后持同mock-connector wiring锁，只添加PRODUCT分支。 所有函数/回调/SQL体<40行、TypeScript无any；金额/时间不默认为0/now，用户文本严格校验并sanitize；密钥仅env。 真实接线Ready要求硬闭包覆盖所有已消费叶子的integrationDependsOn；fixture-Done不能关闭runtime gate。

<a id="p12-013"></a>

## P12-013：注册发布策略和商品后端运行模块

**工时：** 3h（实现 + 定向验证 + PR 准备） · **轨道：** integration · **类型：** integration · **优先级：** P1

**契约：** ListingsModuleWiring / RegisteredProductPublishExecutionStrategy

**输入：**

- P12-002私有upload/P12-003 bounded CSV/P12-005 repository/P12-006 validator/P12-007确定性local rules/P12-008 controller完成
- P12-016/017完整publish proposal/hash/risk与P12-018/019/020真实策略；P12-012 Mock public source adapter
- P07-014/019 human approval runtime、P08-013/021/022 durable dispatch-once/readback worker、P09-004 audit；scope/current authority和P2 causal source gate

**输出：**

- 仅注册listing HTTP/repository/local rules、PRODUCT_PUBLISH完成策略及正常审批/worker接口
- 真实发布仍human批准→一次dispatch→独立readback；web client/page绑定由P12-021负责

**独占文件（新路径为计划创建）：**

- `apps/api/src/listings/listings.module.ts`
- `apps/api/src/listings/listings.module.spec.ts`

**共享文件锁（协调集成修改）：**

- `apps/api/src/app.module.ts`
- `apps/api/src/actions/actions.module.ts`
- `apps/api/src/actions/execution.module.ts`

**硬依赖：** P12-002, P12-003, P12-005, P12-006, P12-007, P12-008, P12-010, P12-012, P12-016, P12-017, P12-018, P12-019, P12-020, P07-014, P07-019, P08-013, P08-021, P08-022, P09-004, P13-001, P2-GATE

**实际接线依赖：** 无

**验收：**

- [ ] 实际upload/parser/local rules/controller接线smoke，无fixture/provider冒充真实依赖
- [ ] registry仅在完成策略与Mock adapter gate后允许PRODUCT_PUBLISH；当前身份/版本/hash/TTL漂移执行前阻断
- [ ] 一次create后ACCEPTED/UNKNOWN保持待验证，readback才SUCCEEDED；PRICE_SET现有回归不变

**测试：**

- pnpm --filter @shopmate/api exec vitest run src/listings/listings.module.spec.ts --maxWorkers 1

**不包含：**

- 真实平台发布/LLM网络调用/部署线上迁移
- 消费者PII导入、公开上传目录或任意URL抓取
- AI审批发布、自动重试未知publish或未经审批覆盖商品

**风险：** 跨领域union注册被误认为默认允许

**并行分组：** `p12-listings.module`

**执行边界：** 拟新增路径；只交付本卡文件，fixture仅在测试目录，组件按已合并契约注入端口并行实现。工时包含实现、聚焦验证和PR准备；函数/回调/SQL体<40行，TS无any，输入strict校验/sanitize、SQL参数化、密钥仅env；独立commit/分支/PR，经独立review、latest CI并合并main才Done。 3h只DI注册+smoke与PR，不扩schema/hash/risk/执行叶子、不实现upload/parser/UI绑定；API roots按锁短时串行合并。 真实接线Ready要求硬闭包覆盖所有已消费叶子的integrationDependsOn；fixture-Done不能关闭runtime gate。

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
- 本卡持runner/config共享锁显式注册必跑目标：packages/database/test/integration/listing-import.test.mjs；API目标tenant config include且default config exclude，DB nested目标由runner显式调用，不依赖test/\*.test.mjs

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
- [ ] pnpm test:tenant仅用isolatedPostgres新建/stop disposable数据库及runner生成TEST_DATABASE_URL/runtime DATABASE_URL；清除继承开发DATABASE_URL，目标集非空且每个注册目标执行>0、0 skipped，零选择或skip失败

**测试：**

- pnpm test:tenant

**不包含：**

- 真实平台发布/LLM网络调用/部署线上迁移
- 消费者PII导入、公开上传目录或任意URL抓取
- AI审批发布、自动重试未知publish或未经审批覆盖商品

**风险：** DB拒绝后私有对象残留

**并行分组：** `p12-listing-import`

**执行边界：** 拟新增路径独占；fixture合成且仅测试，命名端口支持组件并行，runtime integration按依赖接线；1–4小时含定向验证/PR，每卡独立commit/PR、最新CI+审查合并才Done。 所有函数/回调/SQL体<40行、TypeScript无any；金额/时间不默认为0/now，用户文本严格校验并sanitize；密钥仅env。 必跑目标注册属于本卡，不留给未来runner任务；测试database helper只用runner URL，不允许直跑套用开发DATABASE_URL。

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
- 本卡持runner/config共享锁显式注册必跑目标：apps/api/test/listing-publish.e2e-spec.ts；API目标tenant config include且default config exclude，DB nested目标由runner显式调用，不依赖test/\*.test.mjs

**独占文件（新路径为计划创建）：**

- `apps/api/test/listing-publish.e2e-spec.ts`

**共享文件锁（协调集成修改）：**

- `scripts/test-tenant-database.mjs`
- `apps/api/vitest.tenant.config.ts`
- `apps/api/vitest.config.ts`

**硬依赖：** P12-013, P12-014, P07-019, P08-014, P2-GATE, P12-021

**实际接线依赖：** 无

**验收：**

- [ ] 合法草稿完整预览+人工批准后只create一次，readback匹配才成功
- [ ] timeout-after-create/restart/延迟可见保留UNKNOWN/PENDING，无二次create
- [ ] 编辑/过期/撤销/connection generation漂移阻断，B租户无对象/审批可见
- [ ] pnpm test:tenant仅用isolatedPostgres新建/stop disposable数据库及runner生成TEST_DATABASE_URL/runtime DATABASE_URL；清除继承开发DATABASE_URL，目标集非空且每个注册目标执行>0、0 skipped，零选择或skip失败

**测试：**

- pnpm test:tenant

**不包含：**

- 真实平台发布/LLM网络调用/部署线上迁移
- 消费者PII导入、公开上传目录或任意URL抓取
- AI审批发布、自动重试未知publish或未经审批覆盖商品

**风险：** 回读成功前规范库提前伪造发布

**并行分组：** `p12-listing-publish.e2e`

**执行边界：** 拟新增路径独占；fixture合成且仅测试，命名端口支持组件并行，runtime integration按依赖接线；1–4小时含定向验证/PR，每卡独立commit/PR、最新CI+审查合并才Done。 所有函数/回调/SQL体<40行、TypeScript无any；金额/时间不默认为0/now，用户文本严格校验并sanitize；密钥仅env。 必跑目标注册属于本卡，不留给未来runner任务；测试database helper只用runner URL，不允许直跑套用开发DATABASE_URL。

<a id="p12-016"></a>

## P12-016：扩展完整商品发布提案契约

**工时：** 3h（实现 + 定向验证 + PR 准备） · **轨道：** contract · **类型：** contract · **优先级：** P0

**契约：** ProductPublishProposalV1 / ActionStrategyV1 PRODUCT_PUBLISH

**输入：**

- P12-001完整listing snapshot、全部SKU/类目/正文/价格/provenance/validation version
- P07-001 immutable revision/hash/approval绑定与P08-031 typed strategy boundary

**输出：**

- strict PRODUCT_PUBLISH proposal branch与approval payload schema公共root导出
- 完整listing hash输入及独立listing risk version；PRICE_SET字段与行为保持兼容

**独占文件（新路径为计划创建）：**

- `packages/contracts/src/listings/publish-proposal.schema.ts`
- `packages/contracts/src/listings/publish-proposal.schema.spec.ts`

**共享文件锁（协调集成修改）：**

- `packages/contracts/src/actions/proposal.schema.ts`
- `packages/contracts/src/index.ts`

**硬依赖：** P12-001, P07-001, P08-031

**实际接线依赖：** 无

**验收：**

- [ ] 任一SKU/金额/正文/类目/provenance/validationVersion缺失或未知执行字段拒绝
- [ ] price原schema回归兼容；PRODUCT与PRICE branch交叉payload拒绝
- [ ] 包含connection/generation/TTL/evidence refs，approval仍server human绑定，不由草稿自动获得

**测试：**

- pnpm --filter @shopmate/contracts exec vitest run src/listings/publish-proposal.schema.spec.ts src/actions/proposal.schema.spec.ts

**不包含：**

- 真实供应商/LLM网络调用、部署或线上迁移
- 自动审批、UNKNOWN后再次写入或自动补偿

**风险：** listing union字段未纳入批准边界

**并行分组：** `p12-016-publish-proposal`

**执行边界：** 拟新增路径；只交付本卡文件，fixture仅在测试目录，组件按已合并契约注入端口并行实现。工时包含实现、聚焦验证和PR准备；函数/回调/SQL体<40行，TS无any，输入strict校验/sanitize、SQL参数化、密钥仅env；独立commit/分支/PR，经独立review、latest CI并合并main才Done。

<a id="p12-017"></a>

## P12-017：实现商品发布完整哈希和专属风险

**工时：** 3h（实现 + 定向验证 + PR 准备） · **轨道：** backend · **类型：** component · **优先级：** P0

**契约：** ProductPublishHash / ListingPublishRiskPolicy

**输入：**

- P12-016完整immutable snapshot；P12-006 validation结果/ruleVersion与P13-001 capability
- canonical hashing接口复用P07-002，金额仍CNY integer，不复用PriceRiskPolicy阈值

**输出：**

- typed listing canonical bytes/hash与publish-specific deterministic risk/reasons
- 完整内容/全部SKU/source version/provenance进入hash，未知校验/capability默认拒绝

**独占文件（新路径为计划创建）：**

- `apps/api/src/listings/listing-publish-policy.ts`
- `apps/api/src/listings/listing-publish-policy.spec.ts`

**共享文件锁（协调集成修改）：**

- 无

**硬依赖：** P12-016, P07-002

**实际接线依赖：** P12-006, P13-001

**验收：**

- [ ] 改变任意正文/SKU/金额/类目/source版本/validation规则/hash变；key顺序不影响结果
- [ ] 无publishProduct/未知校验/当前scope漂移拒绝，CRITICAL禁止且不沿用price低风险
- [ ] 合法合成listing返回可复算risk+ruleVersion；新hash必须新的human approval，无直接publish

**测试：**

- pnpm --filter @shopmate/api exec vitest run src/listings/listing-publish-policy.spec.ts --maxWorkers 1

**不包含：**

- 真实供应商/LLM网络调用、部署或线上迁移
- 自动审批、UNKNOWN后再次写入或自动补偿

**风险：** 发布内容部分哈希或错套价格风险

**并行分组：** `p12-017-listing-publish-policy`

**执行边界：** 拟新增路径；只交付本卡文件，fixture仅在测试目录，组件按已合并契约注入端口并行实现。工时包含实现、聚焦验证和PR准备；函数/回调/SQL体<40行，TS无any，输入strict校验/sanitize、SQL参数化、密钥仅env；独立commit/分支/PR，经独立review、latest CI并合并main才Done。

<a id="p12-018"></a>

## P12-018：实现发布前核验和绝对商品命令构建

**工时：** 4h（实现 + 定向验证 + PR 准备） · **轨道：** backend · **类型：** component · **优先级：** P0

**契约：** PublishExecutionPreflight / ApprovedProductCommandBuilder

**输入：**

- P08-031 shared current-authority proof；P12-016/017批准完整listing revision/hash/risk
- fresh draft/source versions、当前identity/权限/feature/store/connection generation/publish capability；CreateProductCommand DTO

**输出：**

- kind-specific preflight与strict absolute CreateProductCommand；executionId/key/hash绑定全部listing
- freshness/validation/identity/version漂移停止并要求新预览审批，禁止覆盖已存在商品

**独占文件（新路径为计划创建）：**

- `apps/api/src/listings/publish-execution-preflight.ts`
- `apps/api/src/listings/publish-execution-preflight.spec.ts`
- `apps/api/src/listings/publish-command-builder.ts`
- `apps/api/src/listings/publish-command-builder.spec.ts`

**共享文件锁（协调集成修改）：**

- 无

**硬依赖：** P12-016, P12-017, P08-031

**实际接线依赖：** P07-019, P12-005, P12-006, P12-012, P08-032

**验收：**

- [ ] 完整合法批准snapshot构建全部SKU一次create命令，key/hash/id稳定
- [ ] identity撤销/recent proof缺失/TTL/store/feature/generation变化先拒绝，当前draft version不符重新审批
- [ ] 未知/CRITICAL风险、publish unsupported、半snapshot或price命令混入拒绝；共享授权proof不能被publish绕过

**测试：**

- pnpm --filter @shopmate/api exec vitest run src/listings/publish-execution-preflight.spec.ts src/listings/publish-command-builder.spec.ts --maxWorkers 1

**不包含：**

- 真实供应商/LLM网络调用、部署或线上迁移
- 自动审批、UNKNOWN后再次写入或自动补偿

**风险：** 发布策略绕过执行前最新状态

**并行分组：** `p12-018-publish-execution-preflight`

**执行边界：** 拟新增路径；只交付本卡文件，fixture仅在测试目录，组件按已合并契约注入端口并行实现。工时包含实现、聚焦验证和PR准备；函数/回调/SQL体<40行，TS无any，输入strict校验/sanitize、SQL参数化、密钥仅env；独立commit/分支/PR，经独立review、latest CI并合并main才Done。

<a id="p12-019"></a>

## P12-019：实现一次发布回执与完整商品回读策略

**工时：** 3h（实现 + 定向验证 + PR 准备） · **轨道：** backend · **类型：** component · **优先级：** P0

**契约：** ProductPublishDispatch / ProductPublishVerificationReducer

**输入：**

- P12-018 approved CreateProductCommand；注入createProduct/PRODUCT verifyAction、trusted publishedRef resolver
- P08-019 typed jobs、fenced outcome tx、real readback deadline；原完整snapshot

**输出：**

- 一次createProduct dispatch与ACCEPTED/UNKNOWN→readback-only；完整listing readback reducer
- PRODUCT ref必须绑定same tenant/execution/generation，全部SKU/类目/正文/价格匹配才VERIFIED

**独占文件（新路径为计划创建）：**

- `apps/api/src/listings/publish-dispatch-verification.ts`
- `apps/api/src/listings/publish-dispatch-verification.spec.ts`

**共享文件锁（协调集成修改）：**

- 无

**硬依赖：** P12-016, P12-018, P08-019

**实际接线依赖：** P12-012, P08-009, P08-021, P08-022, P09-004

**验收：**

- [ ] ACCEPTED不成功；timeout-after-create只能恢复可信ref并排VERIFY，不再次create
- [ ] 真实source全字段匹配才成功；缺ref/尚未可见PENDING/UNKNOWN，不猜external id或读规范DB
- [ ] wrong execution/scope/generation/mismatch拒绝；旧fence/audit-job失败整体rollback，deadline停止自动工作

**测试：**

- pnpm --filter @shopmate/api exec vitest run src/listings/publish-dispatch-verification.spec.ts --maxWorkers 1

**不包含：**

- 真实供应商/LLM网络调用、部署或线上迁移
- 自动审批、UNKNOWN后再次写入或自动补偿

**风险：** publish timeout导致第二次新建商品

**并行分组：** `p12-019-publish-dispatch-verification`

**执行边界：** 拟新增路径；只交付本卡文件，fixture仅在测试目录，组件按已合并契约注入端口并行实现。工时包含实现、聚焦验证和PR准备；函数/回调/SQL体<40行，TS无any，输入strict校验/sanitize、SQL参数化、密钥仅env；独立commit/分支/PR，经独立review、latest CI并合并main才Done。

<a id="p12-020"></a>

## P12-020：组合可注册的商品发布策略

**工时：** 2h（实现 + 定向验证 + PR 准备） · **轨道：** backend · **类型：** component · **优先级：** P0

**契约：** ProductPublishExecutionStrategy / ActionStrategyRegistry

**输入：**

- P08-031/032策略registry接口；P12-018 preflight/builder与P12-019 dispatch/verify
- 共享authority facade在kind preflight之前执行；注入端口尚不登记真实模块

**输出：**

- typed PRODUCT_PUBLISH strategy adapter；只组合完成的发布叶子，不重写price executor
- runtime registration留P12-013，fixture证明price与publish kind选择隔离

**独占文件（新路径为计划创建）：**

- `apps/api/src/listings/product-publish-strategy.ts`
- `apps/api/src/listings/product-publish-strategy.spec.ts`

**共享文件锁（协调集成修改）：**

- 无

**硬依赖：** P12-018, P12-019, P08-032

**实际接线依赖：** P12-012, P08-013

**验收：**

- [ ] adapter依顺序共享authority→publish preflight→build→dispatch→verify且完整snapshot不丢
- [ ] 价格仍走PRICE_SET adapter；unknown kind/default/duplicate registration拒绝
- [ ] 未获得shared proof或UNKNOWN dispatch时无第二write；fixture completion不声称runtime可发布

**测试：**

- pnpm --filter @shopmate/api exec vitest run src/listings/product-publish-strategy.spec.ts --maxWorkers 1

**不包含：**

- 真实供应商/LLM网络调用、部署或线上迁移
- 自动审批、UNKNOWN后再次写入或自动补偿

**风险：** DI登记先于发布策略实现

**并行分组：** `p12-020-product-publish-strategy`

**执行边界：** 拟新增路径；只交付本卡文件，fixture仅在测试目录，组件按已合并契约注入端口并行实现。工时包含实现、聚焦验证和PR准备；函数/回调/SQL体<40行，TS无any，输入strict校验/sanitize、SQL参数化、密钥仅env；独立commit/分支/PR，经独立review、latest CI并合并main才Done。

<a id="p12-021"></a>

## P12-021：绑定商品工作区客户端和发布状态页面

**工时：** 3h（实现 + 定向验证 + PR 准备） · **轨道：** integration · **类型：** integration · **优先级：** P0

**契约：** ListingWorkspaceClient / ListingRoute / ExecutionStatusRoute

**输入：**

- P12-013真实listing routes、P12-009 props workspace、P07-014完整审批preview
- P08-025 execution status client/page；draft revision/hash与PRODUCT_PUBLISH proposal id

**输出：**

- listing typed HTTP client与page绑定，完整草稿预览→新提案→人工审批→execution status链接
- upload/edit/generate错误保持原draft，generation明示LOCAL_RULES

**独占文件（新路径为计划创建）：**

- `apps/web/src/app/listings/listing-api.ts`
- `apps/web/src/app/listings/listing-api.test.ts`
- `apps/web/src/app/listings/page.tsx`
- `apps/web/src/app/listings/listing-page.test.tsx`

**共享文件锁（协调集成修改）：**

- `apps/web/src/app/page.tsx`

**硬依赖：** P12-013, P12-009, P07-014, P08-025

**实际接线依赖：** 无

**验收：**

- [ ] 真实导入/编辑/本地生成/完整预览走API，版本冲突409需重新读取，不自动publish
- [ ] 人工批准后新execution链接显示UNKNOWN/PENDING；独立PRODUCT VERIFIED才成功
- [ ] 375px/桌面loading/empty/error、upload取消/切店丢迟到结果；不沿用旧approval，破坏性确认明确

**测试：**

- pnpm --filter @shopmate/web exec vitest run src/app/listings/listing-api.test.ts src/app/listings/listing-page.test.tsx
- pnpm --filter @shopmate/web typecheck

**不包含：**

- 真实供应商/LLM网络调用、部署或线上迁移
- 自动审批、UNKNOWN后再次写入或自动补偿

**风险：** 模块注册没有实际商品UI入口

**并行分组：** `p12-021-listing-api`

**执行边界：** 拟新增路径；只交付本卡文件，fixture仅在测试目录，组件按已合并契约注入端口并行实现。工时包含实现、聚焦验证和PR准备；函数/回调/SQL体<40行，TS无any，输入strict校验/sanitize、SQL参数化、密钥仅env；独立commit/分支/PR，经独立review、latest CI并合并main才Done。 真实接线Ready要求硬闭包覆盖所有已消费叶子的integrationDependsOn；fixture-Done不能关闭runtime gate。
