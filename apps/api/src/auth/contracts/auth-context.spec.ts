import { describe, expect, it } from "vitest";

import { AuthPermission, createAuthContext } from "./auth-context.js";
import { createAuthError } from "./auth-error.js";

describe("认证上下文契约", () => {
  it("只保留服务端授权所需的最小字段", () => {
    const identity = {
      userId: "user-demo-01",
      merchantId: "merchant-demo-01",
      permissions: [AuthPermission.ProductsRead, AuthPermission.OrdersRead],
      email: "owner@shopmate.co.nz",
      passwordHash: "不应进入会话",
    };

    const context = createAuthContext(identity);

    expect(context).toEqual({
      userId: "user-demo-01",
      merchantId: "merchant-demo-01",
      permissions: [AuthPermission.ProductsRead, AuthPermission.OrdersRead],
    });
    expect(context).not.toHaveProperty("email");
    expect(context).not.toHaveProperty("passwordHash");
    expect(Object.isFrozen(context)).toBe(true);
    expect(Object.isFrozen(context.permissions)).toBe(true);
  });

  it("使用固定权限值", () => {
    expect(Object.values(AuthPermission)).toEqual([
      "products:read",
      "products:write",
      "orders:read",
      "inventory:write",
    ]);
  });
});

describe("认证错误契约", () => {
  it.each([
    ["INVALID_CREDENTIALS", "邮箱或密码错误"],
    ["UNAUTHENTICATED", "请先登录"],
    ["FORBIDDEN", "无权执行此操作"],
  ] as const)("为 %s 返回稳定的中文结构", (code, message) => {
    expect(createAuthError(code)).toEqual({ code, message });
  });
});
