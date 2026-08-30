import "reflect-metadata";

import { BadRequestException, ValidationPipe, type ArgumentMetadata } from "@nestjs/common";
import { describe, expect, it } from "vitest";

import { LoginInputDto } from "./login-input.dto.js";

const metadata: ArgumentMetadata = {
  type: "body",
  metatype: LoginInputDto,
};

const pipe = new ValidationPipe({
  transform: true,
  whitelist: true,
  forbidNonWhitelisted: true,
  stopAtFirstError: true,
});

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
    await expect(
      validateLoginInput({
        email: "owner@shopmate.co.nz",
        password: "demo-pass-2026",
        merchantId: "attacker-merchant",
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
