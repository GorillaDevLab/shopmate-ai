# ShopMate AI 中文 Demo 演示清单

## 一、演示前检查

正式演示前确认以下环境变量已配置：

- DATABASE_URL
- DEMO_AUTH_EMAIL
- DEMO_AUTH_PASSWORD
- DEMO_AUTH_USER_ID
- DEMO_AUTH_MERCHANT_ID
- DEMO_SESSION_SECRET
- 如需真实 DeepSeek：DEEPSEEK_API_KEY

禁止在演示、截图、Issue 或 PR 中展示真实 Secret。

初始化 Demo 数据：

```bash
pnpm demo:init
```

启动服务：

```bash
pnpm dev
```

健康检查：

```bash
pnpm demo:health
```

## 二、5～10 分钟正式演示

### 0:00～1:00 — Demo 登录

打开中文登录页，使用 Demo 账号进入经营 Dashboard。

### 1:00～2:00 — 中文经营 Dashboard

展示经营总览、销售与订单指标、Analytics API 数据和日期范围。

### 2:00～3:30 — AI 查询低库存

推荐问题：

```text
最近哪些商品值得补货？
```

说明经营数字必须来自受控 Tool，而不是模型自行编造。

### 3:30～4:30 — AI 分析热销商品

```text
分析一下最近的热销商品。
```

### 4:30～5:30 — AI 总结销售趋势

```text
总结最近的销售趋势。
```

### 5:30～7:00 — 中文商品文案

使用商品 `demo-product-001`，演示小红书文案、中文标题、正文、标签和复制功能。

### 7:00～8:00 — Dashboard 自定义

展示卡片顺序或尺寸调整与布局保存。

### 8:00～9:00 — 经营监听

可使用：

```text
库存低于 4 件时提醒我
```

### 9:00～10:00 — 总结

说明 ShopMate AI 当前是 Demo v0.1，不是完整生产 SaaS。

## 三、已知 Demo 边界

- 使用固定 Seed 商品、SKU 和订单数据
- Demo 登录不是生产身份系统
- 未配置 DeepSeek Key 时使用 Mock Provider
- 真实 LLM 输出存在非确定性
- AI 经营数字必须来自 Tool
- 不连接真实淘宝、天猫、京东或拼多多店铺
- 不处理真实支付、物流和订单履约
- 不自动修改真实店铺数据
- 部分写操作采用 Demo / Fixture
- 不提供完整生产级计费、多租户后台或 SLA

## 四、演示失败时检查

Web/API 异常：

```bash
pnpm demo:health
```

Demo 数据缺失：

```bash
pnpm demo:init
```

Next.js 类型缓存冲突：

```bash
rm -rf apps/web/.next
pnpm typecheck
```

## 五、质量验证

```bash
pnpm test
pnpm typecheck
pnpm lint
pnpm build
pnpm secret:scan
pnpm format:check
```

真实 Production Demo Smoke：

```bash
pnpm demo:smoke:live
```
