export const DEMO_AUTH_CONFIG = Symbol("DEMO_AUTH_CONFIG");

export interface DemoAuthConfig {
  readonly email: string;
  readonly password: string;
  readonly userId: string;
  readonly merchantId: string;
  readonly sessionSecret: string;
  readonly ttlSeconds: number;
  readonly secureCookie: boolean;
}

const requiredKeys = [
  "DEMO_AUTH_EMAIL",
  "DEMO_AUTH_PASSWORD",
  "DEMO_AUTH_USER_ID",
  "DEMO_AUTH_MERCHANT_ID",
  "DEMO_SESSION_SECRET",
] as const;

export function readDemoAuthConfig(env: NodeJS.ProcessEnv): DemoAuthConfig | null {
  if (requiredKeys.every((key) => !env[key]?.trim())) return null;
  const values = Object.fromEntries(requiredKeys.map((key) => [key, requireValue(env, key)]));
  const ttlSeconds = readTtl(env.DEMO_SESSION_TTL_SECONDS);
  validateCredentials(values.DEMO_AUTH_EMAIL, values.DEMO_AUTH_PASSWORD);
  if (values.DEMO_SESSION_SECRET.length < 32) {
    throw new Error("DEMO_SESSION_SECRET 至少需要 32 个字符");
  }
  return {
    email: values.DEMO_AUTH_EMAIL.trim().toLowerCase(),
    password: values.DEMO_AUTH_PASSWORD,
    userId: values.DEMO_AUTH_USER_ID.trim(),
    merchantId: values.DEMO_AUTH_MERCHANT_ID.trim(),
    sessionSecret: values.DEMO_SESSION_SECRET,
    ttlSeconds,
    secureCookie: readSecureCookie(env),
  };
}

function readSecureCookie(env: NodeJS.ProcessEnv): boolean {
  if (env.DEMO_AUTH_SECURE_COOKIE === "false") return false;
  if (env.DEMO_AUTH_SECURE_COOKIE === "true") return true;
  return env.NODE_ENV === "production";
}

export function readOptionalDemoAuthConfig(env: NodeJS.ProcessEnv): DemoAuthConfig | null {
  try {
    return readDemoAuthConfig(env);
  } catch {
    return null;
  }
}

function requireValue(env: NodeJS.ProcessEnv, key: (typeof requiredKeys)[number]): string {
  const value = env[key];
  if (!value?.trim()) throw new Error(`缺少必需环境变量：${key}`);
  return value;
}

function readTtl(raw: string | undefined): number {
  const ttl = raw ? Number(raw) : 3_600;
  if (!Number.isInteger(ttl) || ttl < 60 || ttl > 86_400) {
    throw new Error("DEMO_SESSION_TTL_SECONDS 必须是 60 至 86400 的整数");
  }
  return ttl;
}

function validateCredentials(email: string, password: string): void {
  if (!/^\S+@\S+\.\S+$/.test(email.trim())) throw new Error("DEMO_AUTH_EMAIL 必须是有效邮箱");
  if (password.length < 8 || password.length > 128) {
    throw new Error("DEMO_AUTH_PASSWORD 长度必须为 8 至 128 个字符");
  }
}
