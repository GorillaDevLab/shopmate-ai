# Phase 13 — Real Connector Preparation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans for one explicitly assigned card. Human ownership and all [global constraints](../2026-10-04-p3-p13-agile-task-pool.md) apply.

**Goal:** 交付本阶段卡片列出的、独立可验证的产品能力。

**Architecture:** 按契约并行实现组件，依赖门槛满足后真实接线；不把夹具当作生产完成。

**Tech Stack:** TypeScript / Zod / NestJS / React / Prisma / PostgreSQL / Vitest / Playwright。

<a id="p13-001"></a>

## P13-001：定义Connector准备度和核验字段清单

**工时：** 3h（实现 + 定向验证 + PR 准备） · **轨道：** contract · **类型：** contract · **优先级：** P0

**契约：** ConnectorReadinessManifestV1 / VerifiedFieldManifest

**输入：**

- 现有ConnectorCapabilities/normalized DTO语义
- K官方核验owner/sourceLink/verificationDate/status与权限包边界

**输出：**

- strict manifest capability/permission/field/semantic evidence status
- 未核验/过时/缺权限字段不升级capability的纯契约

**独占文件（新路径为计划创建）：**

- `packages/contracts/src/integrations/readiness.schema.ts`
- `packages/contracts/src/integrations/readiness.schema.spec.ts`

**共享文件锁（协调集成修改）：**

- `packages/contracts/src/index.ts`

**硬依赖：** 无

**实际接线依赖：** 无

**验收：**

- [ ] endpoint/SDK/key原文及unknown capability字段拒绝
- [ ] 缺source/date/范围或过期证据不能READY；UNKNOWN映射UNSUPPORTED
- [ ] readiness不能授予动作权限；真实adapter未批准状态固定PREPARATION_ONLY

**测试：**

- pnpm --filter @shopmate/contracts exec vitest run src/integrations/readiness.schema.spec.ts

**不包含：**

- 真实抖店/Jev/LLM API、OAuth/token exchange、网络transport实现
- 虚构vendor endpoint/SDK/签名算法或能力
- 安装供应商SDK、请求凭据、真实商家数据、部署/线上迁移

**风险：** 资料存在被误视实际能力可用

**并行分组：** `p13-offline-1`

**执行边界：** PREPARATION ONLY；拟新增路径独占；只合成fixture与离线测试/文档，未核验能力UNSUPPORTED，不能宣传已接通真实平台。1–4小时包含验证/PR；独立commit/PR最新CI+审查合并才Done。exports由协调者持contract-index锁；capability list复用现有字段不猜平台名称。 所有函数/回调/SQL体<40行、TypeScript无any；金额/时间不默认为0/now，用户文本严格校验并sanitize；密钥仅env。

<a id="p13-002"></a>

## P13-002：整理官方权限与能力核验台账

**工时：** 3h（实现 + 定向验证 + PR 准备） · **轨道：** research · **类型：** research · **优先级：** P0

**契约：** DouyinVerificationLedgerV1

**输入：**

- K已列官方抖店授权133、接入类型127、权限包193、安全83/4205链接
- 官方公开文档证据，不是实际应用/店铺授权或API成功

**输出：**

- 公开文档核验owner/link/date/status台账
- 商品/订单/退款/库存/营销/token revoke/webhook/CAS/幂等/回滚逐项UNKNOWN或可证范围

**独占文件（新路径为计划创建）：**

- `docs/integrations/douyin-verification-ledger.md`
- `docs/integrations/douyin-evidence-sources.json`

**共享文件锁（协调集成修改）：**

- 无

**硬依赖：** P13-001

**实际接线依赖：** 无

**验收：**

- [ ] 每项有来源、核验日、范围与未决项，旧报告日期不得冒充当前核验
- [ ] 抖音生活服务/来客文档不得充当抖店依据，未知endpoint不补猜
- [ ] 资料字段确认也不声明测试店授权/真实transport ready；无key/SDK/vendor API调用

**测试：**

- 手动核对 docs/integrations/douyin-verification-ledger.md 的每条官方链接、日期、状态与证据原文范围
- pnpm exec prettier --check docs/integrations/douyin-evidence-sources.json

**不包含：**

- 真实抖店/Jev/LLM API、OAuth/token exchange、网络transport实现
- 虚构vendor endpoint/SDK/签名算法或能力
- 安装供应商SDK、请求凭据、真实商家数据、部署/线上迁移

**风险：** 公开文档与应用实际权限不同

**并行分组：** `p13-offline-2`

**执行边界：** PREPARATION ONLY；拟新增路径独占；只合成fixture与离线测试/文档，未核验能力UNSUPPORTED，不能宣传已接通真实平台。1–4小时包含验证/PR；独立commit/PR最新CI+审查合并才Done。仅公开官方文档research；无网络业务请求。不能访问或无确定公开证据的项保持UNKNOWN并记录待验，不写占位端点。 所有函数/回调/SQL体<40行、TypeScript无any；金额/时间不默认为0/now，用户文本严格校验并sanitize；密钥仅env。

<a id="p13-003"></a>

## P13-003：实现离线金额和源版本规范化

**工时：** 3h（实现 + 定向验证 + PR 准备） · **轨道：** backend · **类型：** component · **优先级：** P1

**契约：** ConnectorMoneyVersionNormalizer

**输入：**

- 版本化field manifest及test-only合成原始record；CNY明确单位
- 現有MinorAmountSchema/SourceVersionSchema；opaque源版本不能猜排序

**输出：**

- 严格money→integer minor无浮点近似和opaque version preservation
- 未知单位/汇率/缺sourceVersion返回明确unsupported或quality issue

**独占文件（新路径为计划创建）：**

- `apps/api/src/integrations/preparation/money-version-normalizer.ts`
- `apps/api/src/integrations/preparation/money-version-normalizer.spec.ts`

**共享文件锁（协调集成修改）：**

- 无

**硬依赖：** P13-001

**实际接线依赖：** P13-002

**验收：**

- [ ] 字符串59.00元在已核验单位规则下变5900分
- [ ] 未知币种/单位/超safe integer/多余小数拒绝，不补0
- [ ] opaque version完整保留；无已核验排序规则不按字典序覆盖记录

**测试：**

- pnpm --filter @shopmate/api exec vitest run src/integrations/preparation/money-version-normalizer.spec.ts --maxWorkers 1

**不包含：**

- 真实抖店/Jev/LLM API、OAuth/token exchange、网络transport实现
- 虚构vendor endpoint/SDK/签名算法或能力
- 安装供应商SDK、请求凭据、真实商家数据、部署/线上迁移

**风险：** 人民币元分混淆或opaque版本乱序

**并行分组：** `p13-offline-3`

**执行边界：** PREPARATION ONLY；拟新增路径独占；只合成fixture与离线测试/文档，未核验能力UNSUPPORTED，不能宣传已接通真实平台。1–4小时包含验证/PR；独立commit/PR最新CI+审查合并才Done。 所有函数/回调/SQL体<40行、TypeScript无any；金额/时间不默认为0/now，用户文本严格校验并sanitize；密钥仅env。

<a id="p13-004"></a>

## P13-004：实现离线时间和状态语义规范化

**工时：** 3h（实现 + 定向验证 + PR 准备） · **轨道：** backend · **类型：** component · **优先级：** P1

**契约：** ConnectorTimeStatusNormalizer

**输入：**

- verified-field timezone/created/paid/refund-settled语义manifest
- 现有ConnectorTimestamp/normalized order/refund枚举；合成raw record

**输出：**

- explicit offset timestamp normalization与字段来源
- 未知状态/paidAt缺失/歧义时区明确UNSUPPORTED或qualityissue

**独占文件（新路径为计划创建）：**

- `apps/api/src/integrations/preparation/time-status-normalizer.ts`
- `apps/api/src/integrations/preparation/time-status-normalizer.spec.ts`

**共享文件锁（协调集成修改）：**

- 无

**硬依赖：** P13-001

**实际接线依赖：** P13-002

**验收：**

- [ ] 已核验Asia/Shanghai时间映射保留对应instant与原字段语义
- [ ] PENDING不得计PAID，退款申请不当settledAt
- [ ] 未知status、无timezone/非法时间拒绝或保留未知，不用now/零填缺事实

**测试：**

- pnpm --filter @shopmate/api exec vitest run src/integrations/preparation/time-status-normalizer.spec.ts --maxWorkers 1

**不包含：**

- 真实抖店/Jev/LLM API、OAuth/token exchange、网络transport实现
- 虚构vendor endpoint/SDK/签名算法或能力
- 安装供应商SDK、请求凭据、真实商家数据、部署/线上迁移

**风险：** 申请时间误当财务结算事实

**并行分组：** `p13-offline-4`

**执行边界：** PREPARATION ONLY；拟新增路径独占；只合成fixture与离线测试/文档，未核验能力UNSUPPORTED，不能宣传已接通真实平台。1–4小时包含验证/PR；独立commit/PR最新CI+审查合并才Done。 所有函数/回调/SQL体<40行、TypeScript无any；金额/时间不默认为0/now，用户文本严格校验并sanitize；密钥仅env。

<a id="p13-005"></a>

## P13-005：建立最小化的合成golden fixture包

**工时：** 3h（实现 + 定向验证 + PR 准备） · **轨道：** qa · **类型：** component · **优先级：** P1

**契约：** OfflineConnectorGoldenFixturesV1

**输入：**

- 现有ConnectorProduct/Order/Refund/Inventory/Marketing schema
- 仅synthetic field/values，有provenance区分自造contract fixture与官方示例

**输出：**

- 版本化golden fixtures+expected normalized output/error
- 包含money/time/status/缺字段/PII-redaction负例；无真实payload/token

**独占文件（新路径为计划创建）：**

- `apps/api/test/fixtures/connector-preparation/golden.json`
- `apps/api/test/fixtures/connector-preparation/manifest.json`
- `apps/api/test/connector-preparation-fixtures.spec.ts`

**共享文件锁（协调集成修改）：**

- 无

**硬依赖：** P13-001

**实际接线依赖：** P13-002

**验收：**

- [ ] fixture manifest标SYNTHETIC，不能声称实测vendor响应
- [ ] 联系人/phone/token字段在最小化输出及error/log fixture均不出现
- [ ] 未核验字段expected UNSUPPORTED/unknown quality，缺成本不expected0

**测试：**

- pnpm --filter @shopmate/api exec vitest run test/connector-preparation-fixtures.spec.ts --maxWorkers 1

**不包含：**

- 真实抖店/Jev/LLM API、OAuth/token exchange、网络transport实现
- 虚构vendor endpoint/SDK/签名算法或能力
- 安装供应商SDK、请求凭据、真实商家数据、部署/线上迁移

**风险：** 自造fixture被当官方golden协议

**并行分组：** `p13-offline-5`

**执行边界：** PREPARATION ONLY；拟新增路径独占；只合成fixture与离线测试/文档，未核验能力UNSUPPORTED，不能宣传已接通真实平台。1–4小时包含验证/PR；独立commit/PR最新CI+审查合并才Done。 所有函数/回调/SQL体<40行、TypeScript无any；金额/时间不默认为0/now，用户文本严格校验并sanitize；密钥仅env。

<a id="p13-006"></a>

## P13-006：验证离线映射和capability协商

**工时：** 3h（实现 + 定向验证 + PR 准备） · **轨道：** qa · **类型：** verification · **优先级：** P1

**契约：** ConnectorPreparationConformance

**输入：**

- golden contract fixtures、money/time normalizers和readiness manifest
- 现有CommerceConnector schema validation与permissions boundary

**输出：**

- offline conformance runner/report；不实例化任何real vendor transport
- verified field readiness与capability negotiation结果

**独占文件（新路径为计划创建）：**

- `apps/api/src/integrations/preparation/conformance.ts`
- `apps/api/src/integrations/preparation/conformance.spec.ts`

**共享文件锁（协调集成修改）：**

- 无

**硬依赖：** P13-001, P13-003, P13-004, P13-005

**实际接线依赖：** 无

**验收：**

- [ ] synthetic已证规则映射满足strict connector DTO且可复算
- [ ] 任何未核验写/CAS/幂等/营销能力都UNSUPPORTED，不能被配置override强开
- [ ] unknown raw字段/PII剔除；缺时间/金额字段不填now/0；测试不产生网络调用

**测试：**

- pnpm --filter @shopmate/api exec vitest run src/integrations/preparation/conformance.spec.ts --maxWorkers 1

**不包含：**

- 真实抖店/Jev/LLM API、OAuth/token exchange、网络transport实现
- 虚构vendor endpoint/SDK/签名算法或能力
- 安装供应商SDK、请求凭据、真实商家数据、部署/线上迁移

**风险：** 离线通过被误称真实adapter验收

**并行分组：** `p13-offline-6`

**执行边界：** PREPARATION ONLY；拟新增路径独占；只合成fixture与离线测试/文档，未核验能力UNSUPPORTED，不能宣传已接通真实平台。1–4小时包含验证/PR；独立commit/PR最新CI+审查合并才Done。 所有函数/回调/SQL体<40行、TypeScript无any；金额/时间不默认为0/now，用户文本严格校验并sanitize；密钥仅env。

<a id="p13-007"></a>

## P13-007：编写后续真实接入和迁移交接门禁

**工时：** 3h（实现 + 定向验证 + PR 准备） · **轨道：** research · **类型：** research · **优先级：** P1

**契约：** RealConnectorPreparationHandoff

**输入：**

- approved K控制设计与offline readiness report
- 当前deploy/migration deferred tracker、separate migration/runtime identities

**输出：**

- 未来真实接入审批资料：权限/区域/最小化/secretRef/revoke/回读/恢复门禁
- 增量mapping/sync migration验收清单及本地旧→新contract replay步骤

**独占文件（新路径为计划创建）：**

- `docs/integrations/real-connector-handoff.md`
- `docs/integrations/connector-migration-acceptance.md`

**共享文件锁（协调集成修改）：**

- 无

**硬依赖：** P13-002, P13-006

**实际接线依赖：** P07-019, P08-015, P12-015

**验收：**

- [ ] 文档明确PREPARATION ONLY与哪些能力未经实店授权/transport核验
- [ ] 列出未来独立批准后才允许OAuth、真实写、真实golden/签名和平台权限验证
- [ ] 部署/线上migration由用户另行执行；无命令访问线上DB/secret或绕过P3009/BYPASSRLS

**测试：**

- 手动逐项对照 docs/integrations/real-connector-handoff.md 与 docs/architecture/2026-10-03-product-execution-tracker.md 的 deferred boundaries
- pnpm exec prettier --check docs/integrations/real-connector-handoff.md docs/integrations/connector-migration-acceptance.md

**不包含：**

- 真实抖店/Jev/LLM API、OAuth/token exchange、网络transport实现
- 虚构vendor endpoint/SDK/签名算法或能力
- 安装供应商SDK、请求凭据、真实商家数据、部署/线上迁移

**风险：** 迁移交接被自动执行部署

**并行分组：** `p13-offline-7`

**执行边界：** PREPARATION ONLY；拟新增路径独占；只合成fixture与离线测试/文档，未核验能力UNSUPPORTED，不能宣传已接通真实平台。1–4小时包含验证/PR；独立commit/PR最新CI+审查合并才Done。交接仅文档门禁，不交付真实adapter或部署run；当前P7/8/12完成状态不能推导平台权限。 所有函数/回调/SQL体<40行、TypeScript无any；金额/时间不默认为0/now，用户文本严格校验并sanitize；密钥仅env。
