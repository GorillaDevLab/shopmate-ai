import { describe, expect, it } from "vitest";

import {
  DEFAULT_DEEPSEEK_MODEL,
  DEFAULT_DEEPSEEK_TIMEOUT_MS,
  readDeepSeekEnv,
  requireDeepSeekApiKey,
} from "./deepseek-env.js";

describe("DeepSeek 环境变量", () => {
  it("允许未配置密钥并使用默认配置", () => {
    expect(readDeepSeekEnv({})).toEqual({
      apiKey: undefined,
      baseUrl: "https://api.deepseek.com",
      model: DEFAULT_DEEPSEEK_MODEL,
      timeoutMs: DEFAULT_DEEPSEEK_TIMEOUT_MS,
    });
  });

  it("把空白密钥视为未配置", () => {
    expect(
      readDeepSeekEnv({
        DEEPSEEK_API_KEY: "  ",
      }).apiKey,
    ).toBeUndefined();
  });

  it("保留合法密钥并支持自定义配置", () => {
    expect(
      readDeepSeekEnv({
        DEEPSEEK_API_KEY: "demo-key",
        DEEPSEEK_BASE_URL: "https://proxy.example.com/v1/",
        DEEPSEEK_MODEL: "deepseek-v4-pro",
        DEEPSEEK_TIMEOUT_MS: "45000",
      }),
    ).toEqual({
      apiKey: "demo-key",
      baseUrl: "https://proxy.example.com/v1/",
      model: "deepseek-v4-pro",
      timeoutMs: 45_000,
    });
  });

  it("拒绝非 HTTP(S) 地址", () => {
    expect(() =>
      readDeepSeekEnv({
        DEEPSEEK_BASE_URL: "file:///tmp/key",
      }),
    ).toThrow("DEEPSEEK_BASE_URL 必须是 HTTP(S) 地址");
  });

  it("拒绝不支持的模型", () => {
    expect(() =>
      readDeepSeekEnv({
        DEEPSEEK_MODEL: "fake-model",
      }),
    ).toThrow("DEEPSEEK_MODEL 不受支持：fake-model");
  });

  it.each(["0", "-1", "1.5", "abc", "300001"])("拒绝非法 Timeout：%s", (timeout) => {
    expect(() =>
      readDeepSeekEnv({
        DEEPSEEK_TIMEOUT_MS: timeout,
      }),
    ).toThrow("DEEPSEEK_TIMEOUT_MS 必须是 1 到 300000 之间的整数");
  });

  it("调用 AI 前对缺失密钥给出具体错误", () => {
    expect(() =>
      requireDeepSeekApiKey({
        apiKey: undefined,
      }),
    ).toThrow("缺少必需环境变量：DEEPSEEK_API_KEY");
  });

  it("调用 AI 前返回已配置密钥", () => {
    expect(
      requireDeepSeekApiKey({
        apiKey: "demo-key",
      }),
    ).toBe("demo-key");
  });
});
