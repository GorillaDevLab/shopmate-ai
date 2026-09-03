import assert from "node:assert/strict";
import test from "node:test";

import { LIVE_DEMO_AUTH, requireLiveValue } from "../scripts/demo-live-env.mjs";

test("J4 Live Smoke 缺少真实 Provider Key 时明确失败", () => {
  assert.throws(
    () =>
      requireLiveValue(
        {
          DEEPSEEK_API_KEY: "",
        },
        "DEEPSEEK_API_KEY",
      ),
    /DEEPSEEK_API_KEY/u,
  );
});

test("J4 Demo 登录 Fixture 不包含真实用户凭据", () => {
  assert.equal(LIVE_DEMO_AUTH.DEMO_AUTH_EMAIL, "owner@shopmate.co.nz");

  assert.equal(LIVE_DEMO_AUTH.DEMO_AUTH_MERCHANT_ID, "demo-merchant-cn");

  assert.match(LIVE_DEMO_AUTH.DEMO_SESSION_SECRET, /j4-live-smoke/u);
});

test("J4 Live Smoke 不允许缺少数据库配置", () => {
  assert.throws(
    () =>
      requireLiveValue(
        {
          DATABASE_URL: "",
        },
        "DATABASE_URL",
      ),
    /DATABASE_URL/u,
  );
});
