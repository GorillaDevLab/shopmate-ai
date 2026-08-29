import { describe, expect, it } from "vitest";
import { readDeepSeekEnv, requireDeepSeekApiKey } from "./deepseek-env.js";

describe("DeepSeek 环境变量", () => {
  it("允许未配置密钥并使用默认地址", () => {
    expect(readDeepSeekEnv({})).toEqual({
      apiKey: undefined,
      baseUrl: "https://api.deepseek.com",
    });
  });

  it("把空白密钥视为未配置", () => {
    expect(readDeepSeekEnv({ DEEPSEEK_API_KEY: "  " }).apiKey).toBeUndefined();
  });

  it("保留合法密钥并支持自定义 HTTPS 地址", () => {
    expect(
      readDeepSeekEnv({
        DEEPSEEK_API_KEY: "demo-key",
        DEEPSEEK_BASE_URL: "https://proxy.example.com/v1/",
      }),
    ).toEqual({
      apiKey: "demo-key",
      baseUrl: "https://proxy.example.com/v1/",
    });
  });

  it("拒绝非 HTTP(S) 地址", () => {
    expect(() => readDeepSeekEnv({ DEEPSEEK_BASE_URL: "file:///tmp/key" })).toThrow(
      "DEEPSEEK_BASE_URL 必须是 HTTP(S) 地址",
    );
  });

  it("调用 AI 前对缺失密钥给出具体错误", () => {
    expect(() => requireDeepSeekApiKey({ apiKey: undefined })).toThrow(
      "缺少必需环境变量：DEEPSEEK_API_KEY",
    );
  });

  it("调用 AI 前返回已配置的密钥", () => {
    expect(requireDeepSeekApiKey({ apiKey: "demo-key" })).toBe("demo-key");
  });
});
