import "reflect-metadata";

import { BadRequestException, type ArgumentMetadata } from "@nestjs/common";
import { describe, expect, it } from "vitest";

import { createGlobalValidationPipe } from "../../app.config.js";
import { LoginInputDto } from "./login-input.dto.js";

const metadata: ArgumentMetadata = {
  type: "body",
  metatype: LoginInputDto,
};

const pipe = createGlobalValidationPipe();

async function validateLoginInput(input: Record<string, unknown>): Promise<LoginInputDto> {
  return pipe.transform(input, metadata);
}

describe("LoginInputDto", () => {
  it("接受 email 和 password，并规范化邮箱", async () => {
    const result = await validateLoginInput({
      email: "  Owner@ShopMate.CO.NZ ",
      password: "demo-pass-2026",
    });

    expect(result).toEqual({
      email: "owner@shopmate.co.nz",
      password: "demo-pass-2026",
    });
  });

  it.each([
    { email: "不是邮箱", password: "demo-pass-2026" },
    { email: "owner@shopmate.co.nz", password: "short" },
    { email: "owner@shopmate.co.nz", password: "x".repeat(129) },
  ])("拒绝非法登录边界 %#", async (input) => {
    await expect(validateLoginInput(input)).rejects.toBeInstanceOf(BadRequestException);
  });

  it("拒绝客户端覆盖 merchantId", async () => {
    const error = await validateLoginInput({
      email: "owner@shopmate.co.nz",
      password: "demo-pass-2026",
      merchantId: "attacker-merchant",
    }).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as BadRequestException).getResponse()).toEqual({
      statusCode: 400,
      error: "请求参数无效",
      message: "请求参数校验失败",
    });
  });
});
