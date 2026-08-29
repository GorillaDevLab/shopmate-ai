const DEFAULT_BASE_URL = "https://api.deepseek.com";

export type DeepSeekConfig = {
  apiKey: string | undefined;
  baseUrl: string;
};

export function readDeepSeekEnv(env: NodeJS.ProcessEnv): DeepSeekConfig {
  const baseUrl = env.DEEPSEEK_BASE_URL?.trim() || DEFAULT_BASE_URL;
  validateBaseUrl(baseUrl);

  const apiKey = env.DEEPSEEK_API_KEY?.trim() || undefined;
  return { apiKey, baseUrl };
}

export function requireDeepSeekApiKey(config: Pick<DeepSeekConfig, "apiKey">): string {
  if (!config.apiKey) {
    throw new Error("缺少必需环境变量：DEEPSEEK_API_KEY");
  }

  return config.apiKey;
}

function validateBaseUrl(baseUrl: string): void {
  try {
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("invalid protocol");
    }
  } catch {
    throw new Error("DEEPSEEK_BASE_URL 必须是 HTTP(S) 地址");
  }
}
