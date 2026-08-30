import { Body, Controller, HttpCode, Post, Res } from "@nestjs/common";

import { LoginInputDto } from "./contracts/index.js";
import { DemoAuthService } from "./demo-auth.service.js";

const SESSION_COOKIE_NAME = "shopmate_demo_session";

interface CookieResponse {
  cookie(
    name: string,
    value: string,
    options: {
      httpOnly: boolean;
      sameSite: "lax";
      secure: boolean;
      maxAge: number;
      path: string;
    },
  ): void;
}

@Controller({ path: "auth", version: "1" })
export class DemoAuthController {
  constructor(private readonly authService: DemoAuthService) {}

  @Post("login")
  @HttpCode(200)
  login(@Body() input: LoginInputDto, @Res({ passthrough: true }) response: CookieResponse) {
    const result = this.authService.login(input);
    response.cookie(SESSION_COOKIE_NAME, result.token, {
      httpOnly: true,
      sameSite: "lax",
      secure: result.secureCookie,
      maxAge: result.ttlSeconds * 1_000,
      path: "/",
    });
    return { message: "登录成功", expiresAt: result.expiresAt };
  }
}
