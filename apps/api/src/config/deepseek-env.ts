const DEFAULT_BASE_URL = "https://api.deepseek.com";

export const DEFAULT_DEEPSEEK_MODEL = "deepseek-v4-flash";

export const DEFAULT_DEEPSEEK_TIMEOUT_MS = 30_000;

export const DEEPSEEK_MODELS = ["deepseek-v4-flash", "deepseek-v4-pro"] as const;

export type DeepSeekModel = (typeof DEEPSEEK_MODELS)[number];

export type DeepSeekConfig = {
  apiKey: string | undefined;
  baseUrl: string;
  model: DeepSeekModel;
  timeoutMs: number;
};

export function readDeepSeekEnv(env: NodeJS.ProcessEnv): DeepSeekConfig {
  const baseUrl = env.DEEPSEEK_BASE_URL?.trim() || DEFAULT_BASE_URL;

  validateBaseUrl(baseUrl);

  const apiKey = env.DEEPSEEK_API_KEY?.trim() || undefined;

  const model = parseModel(env.DEEPSEEK_MODEL);

  const timeoutMs = parseTimeoutMs(env.DEEPSEEK_TIMEOUT_MS);

  return {
    apiKey,
    baseUrl,
    model,
    timeoutMs,
  };
}

export function requireDeepSeekApiKey(config: Pick<DeepSeekConfig, "apiKey">): string {
  if (!config.apiKey) {
    throw new Error("缺少必需环境变量：DEEPSEEK_API_KEY");
  }

  return config.apiKey;
}

function parseModel(value: string | undefined): DeepSeekModel {
  const model = value?.trim() || DEFAULT_DEEPSEEK_MODEL;

  if (!DEEPSEEK_MODELS.includes(model as DeepSeekModel)) {
    throw new Error(`DEEPSEEK_MODEL 不受支持：${model}`);
  }

  return model as DeepSeekModel;
}

function parseTimeoutMs(value: string | undefined): number {
  if (!value?.trim()) {
    return DEFAULT_DEEPSEEK_TIMEOUT_MS;
  }

  const timeoutMs = Number(value);

  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 300_000) {
    throw new Error("DEEPSEEK_TIMEOUT_MS 必须是 1 到 300000 之间的整数");
  }

  return timeoutMs;
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
