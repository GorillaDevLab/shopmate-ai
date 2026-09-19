# 临时移动端诊断面板

## 用途

这是一个临时排查开关，不发邮件、不调用 AI、不写数据库，也不需要 API 密钥。打开前端构建开关后，移动端右下角会出现“诊断”按钮。用户打开后可以复制诊断文本，或者在剪贴板不可用时直接截图发给开发者。

它在 React hydration 之前安装，因此页面组件加载失败时仍会尽量显示入口；如果脚本本身没有执行（例如 HTML 或脚本请求完全失败），浏览器不会有任何页面代码可以创建按钮，此时需要用户截图浏览器错误页或开发者工具。

## 开启与关闭

在 Web 构建环境（本地 `apps/web/.env.local` 或部署构建变量）设置：

```dotenv
NEXT_PUBLIC_ENABLE_DEBUG_REPORT=true
NEXT_PUBLIC_APP_BUILD=your-commit-sha
```

不需要设置任何 API 邮件变量。关闭时改回 `false`，重新构建并部署 Web，再让用户刷新页面。用户也可以在诊断面板中点击“关闭诊断入口”，该偏好保存在当前浏览器，刷新后保持关闭。

## 采集内容与隐私

面板只显示内存中的脱敏信息：最近 60 条运行时错误、未处理 Promise、console.error、失败请求元数据、资源/CSP 错误、浏览器与设备提示、视口、页面路径、构建版本和存储键名。

不会读取请求头、请求体、响应体、Cookie 值、localStorage/sessionStorage 值或 AI 内容；URL 查询参数、凭据、常见 token、邮箱和长数字会被隐藏。自由文本中的任意个人信息无法保证被识别，用户仍应避免输入敏感信息。

## 本地验证

```bash
pnpm --filter @shopmate/web exec vitest run src/app/mobile-debug-script.test.ts
pnpm --filter @shopmate/web typecheck
```

生产构建可以用 `NEXT_PUBLIC_ENABLE_DEBUG_REPORT=true` 输出到临时构建目录，再在 jsdom 中执行内联脚本确认按钮和面板能在 hydration 前创建。验证不调用 AI、邮箱或外部网络。

## 退出方式

将 `NEXT_PUBLIC_ENABLE_DEBUG_REPORT=false` 重新构建并发布即可移除诊断脚本。该功能只用于当前排查窗口，问题定位完成后应关闭。
