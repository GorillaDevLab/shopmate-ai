import { describe, expect, it } from "vitest";

import { readDemoAuthConfig } from "./demo-auth.config.js";

describe("Demo 登录配置", () => {
  it("从环境变量读取凭据、身份和会话设置", () => {
    expect(
      readDemoAuthConfig({
        NODE_ENV: "production",
        DEMO_AUTH_EMAIL: " Owner@ShopMate.CO.NZ ",
        DEMO_AUTH_PASSWORD: "demo-pass-2026",
        DEMO_AUTH_USER_ID: "demo-user",
        DEMO_AUTH_MERCHANT_ID: "demo-merchant",
        DEMO_SESSION_SECRET: "test-session-secret-with-at-least-32-characters",
        DEMO_SESSION_TTL_SECONDS: "3600",
      }),
    ).toMatchObject({
      email: "owner@shopmate.co.nz",
      userId: "demo-user",
      merchantId: "demo-merchant",
      ttlSeconds: 3600,
      secureCookie: true,
    });
  });

  it("无配置时保持登录功能关闭", () => {
    expect(readDemoAuthConfig({})).toBeNull();
  });

  it("保留密码和会话密钥中的有效空格", () => {
    const config = readDemoAuthConfig({
      DEMO_AUTH_EMAIL: "owner@shopmate.co.nz",
      DEMO_AUTH_PASSWORD: " demo-pass-2026 ",
      DEMO_AUTH_USER_ID: "demo-user",
      DEMO_AUTH_MERCHANT_ID: "demo-merchant",
      DEMO_SESSION_SECRET: " test-session-secret-with-at-least-32-characters ",
    });

    expect(config?.password).toBe(" demo-pass-2026 ");
    expect(config?.sessionSecret).toBe(" test-session-secret-with-at-least-32-characters ");
  });

  it.each([
    ["短密钥", { DEMO_SESSION_SECRET: "too-short" }],
    ["过长有效期", { DEMO_SESSION_TTL_SECONDS: "86401" }],
  ])("拒绝%s", (_label, override) => {
    const env = {
      DEMO_AUTH_EMAIL: "owner@shopmate.co.nz",
      DEMO_AUTH_PASSWORD: "demo-pass-2026",
      DEMO_AUTH_USER_ID: "demo-user",
      DEMO_AUTH_MERCHANT_ID: "demo-merchant",
      DEMO_SESSION_SECRET: "test-session-secret-with-at-least-32-characters",
      DEMO_SESSION_TTL_SECONDS: "3600",
      ...override,
    };

    expect(() => readDemoAuthConfig(env)).toThrow();
  });
});
