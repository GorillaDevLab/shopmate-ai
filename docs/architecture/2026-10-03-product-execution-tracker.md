# Shopmate AI 持续研发与验收记录

授权：用户要求按已批准路线连续完成研发，每个独立单元创建 PR，最新 CI 与审查通过后代理自行合并并继续。分支用 feat/add/fix，独立可验证变更单独 commit。2026-10-03 用户随后明确：暂不处理部署和线上迁移，完成后由用户执行；本阶段只更新 GitHub。真实抖店调用和真实 Jev 接入保留独立批准边界。

## 已合并

- Phase 1.1 租户基础：[PR #202](https://github.com/GorillaDevLab/shopmate-ai/pull/202)。旧商家接口与生产身份完善仍是上线门槛。
- Phase 1.2 CommerceConnector 契约：[PR #203](https://github.com/GorillaDevLab/shopmate-ai/pull/203)。
- Phase 2.1 因果历史源、四画像、业务时钟：[PR #204](https://github.com/GorillaDevLab/shopmate-ai/pull/204)。
- Phase 2.2 只读 Connector、固定快照分页与 Factory 端口：[PR #205](https://github.com/GorillaDevLab/shopmate-ai/pull/205)。全仓/隔离数据库共 1,316 tests passed，PR CI success。

## 连续实施顺序

- [ ] Phase 2.3 持久 Demo Session、PlatformConnection、演示租户标记、服务端管理与实际 resolver。
- [ ] Phase 2.4 运行源状态、场景引擎、15 个场景、故障注入及完整因果证据。
- [ ] Phase 2.5 同步宿主、固定窗口分页、去重/乱序保护、运行恢复及 freshness。
- [ ] Phase 3 财务/经营 Metric Engine、质量状态、证据版本与口径回归。
- [ ] Phase 4 Event Engine、DecisionProvider、RulesDecisionProvider、结构化决策与路由安全规则。
- [ ] Phase 5 经营概览、证据页、加载/空/错误状态，375px 与桌面验收。
- [ ] Phase 6 Ask Your Store Agent 从统一工具取证、结构化答案、费用/出站策略与明确离线 fallback。
- [ ] Phase 7 提案/风险/人工审批、持久状态机、身份与内容/版本绑定。
- [ ] Phase 8 受控 Mock 写、幂等、结果未知恢复与 read-back verification；首个闭环单 SKU 价格。
- [ ] Phase 9 全链审计及查询 UI；必要审计写入随前置状态管理一起交付。
- [ ] Phase 10 Daily Brief、可靠站内通知、去重/冷却及五分钟演示故事。
- [ ] Phase 11 目标驱动 Agent，沿用证据与审批门禁。
- [ ] Phase 12 商品导入/生成/预览/审批/Mock 发布与验证。
- [ ] Phase 13 真实 Connector 准备、能力/权限核验清单与迁移验收；不调用真实平台。

## 每个单元的交付门槛

需求与边界 → 文件化方案 → 关键路径失败测试 → 实现 → 相关测试与必要全仓/数据库/浏览器验证 → 独立审查及回归 → 分开 commit → PR/附加聊天 → 最新 CI success → 合并 → 更新下一阶段。功能完成必须有可调用/可操作结果，纯契约或方案不计为对应完整产品功能。

## 暂缓的部署事项

线上迁移 `20261003030000_tenant_compatibility_hardening` 有失败记录，后续 deploy 报 P3009。本机隔离 PostgreSQL 已复现受限角色会触发 provisioning identity 检查，并且事务全部回滚。部署工作流此前复用 runtime DATABASE_URL，是高度吻合的原因；没有访问线上数据库，不把推断当作线上角色实测。未来由用户在备份与独立 migration identity 条件下核对/恢复，不能提升应用角色 BYPASSRLS 或静默清除未知失败迁移。

代码合并会触发现有部署 workflow；其结果不能作为本次“已上线”结论。用户部署前统一整理新增 migrations、权限授予、环境配置、数据初始化与恢复步骤。
