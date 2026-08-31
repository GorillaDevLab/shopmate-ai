import { Body, Controller, HttpCode, Post, Res } from "@nestjs/common";

import { LoginInputDto } from "./contracts/index.js";
import { DemoAuthService } from "./demo-auth.service.js";
import { Public } from "./access/public.decorator.js";
import { DEMO_SESSION_COOKIE_NAME } from "./session/demo-session-cookie.js";

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
  clearCookie(
    name: string,
    options: { httpOnly: boolean; sameSite: "lax"; secure: boolean; path: string },
  ): void;
}

@Controller({ path: "auth", version: "1" })
export class DemoAuthController {
  constructor(private readonly authService: DemoAuthService) {}

  @Post("login")
  @HttpCode(200)
  @Public()
  login(@Body() input: LoginInputDto, @Res({ passthrough: true }) response: CookieResponse) {
    const result = this.authService.login(input);
    response.cookie(DEMO_SESSION_COOKIE_NAME, result.token, {
      httpOnly: true,
      sameSite: "lax",
      secure: result.secureCookie,
      maxAge: result.ttlSeconds * 1_000,
      path: "/",
    });
    return { message: "登录成功", expiresAt: result.expiresAt };
  }

  @Post("logout")
  @HttpCode(200)
  @Public()
  logout(@Res({ passthrough: true }) response: CookieResponse) {
    response.clearCookie(DEMO_SESSION_COOKIE_NAME, {
      httpOnly: true,
      sameSite: "lax",
      secure: this.authService.usesSecureCookie(),
      path: "/",
    });
    return { message: "已退出登录" };
  }
}
