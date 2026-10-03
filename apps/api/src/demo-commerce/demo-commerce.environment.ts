export const DEMO_COMMERCE_ENV = Symbol("DEMO_COMMERCE_ENV");

export interface DemoCommerceEnvironment {
  readonly enabled: boolean;
  readonly origin: string | null;
}
export function readDemoCommerceEnvironment(env: NodeJS.ProcessEnv): DemoCommerceEnvironment {
  const origin = readOrigin(env.APP_ORIGIN);
  const enabled = env.APP_ENV === "demo" && env.ENABLE_DEMO_MODE === "true" && origin !== null;
  return Object.freeze({ enabled, origin: enabled ? origin : null });
}

function readOrigin(input: string | undefined): string | null {
  // Reject raw paths before URL normalization can collapse them to the root.
  if (!input || !/^https?:\/\/[^@/?#\\\s]+\/?$/iu.test(input)) return null;
  try {
    const url = new URL(input);
    if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) return null;
    return url.origin;
  } catch {
    return null;
  }
}
